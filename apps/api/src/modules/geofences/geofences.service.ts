import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Geofence, type GeofenceType } from "@prisma/client";

import type {
  CreateGeofenceInput,
  GeofenceSortColumn,
  GeofenceSortDir,
  UpdateGeofenceInput,
} from "./geofences.schemas";
import { validateGeofenceOwnership } from "./geofences.schemas";

// Re-export the schema-inferred input types so call sites (the controller and
// tests) can pull them from this module — the same convention every other
// aggregate service follows.
export type { CreateGeofenceInput, UpdateGeofenceInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value import
// at runtime so the DI container can resolve it. Same eslint override as every
// other vertical-slice service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: Geofence[];
  total: number;
}

// Pagination defaults and bounds — same `LIST_TAKE_` prefix and 200 ceiling
// every Phase-1 list service uses. The clamp in `list` is defense-in-depth:
// the controller validates `take` against the same ceiling via the schema, but
// the service is also exported (the future T5/G5 wiring may fetch a fence by
// id), so a clamp here ensures the database is never asked for an unbounded
// result regardless of how the call site reaches the service.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Prisma's FK-constraint violation code. On a Geofence write (POST/PATCH) it
// means a stale `customerId` (or, defensively, `createdById`) — the referenced
// row does not exist. Mapped to HTTP 400 per docs/runbook/api-error-mapping.md
// (the insert/update-with-stale-FK arm), distinct from the delete-when-
// referenced 409 arm (which lives on CustomersService, not here: nothing FKs
// INTO Geofence, so GeofencesService.delete never raises P2003).
const PRISMA_FK_VIOLATION = "P2003";

// Prisma's "raw query failed" code. ST_GeomFromText throws on structurally
// broken WKT (ADR-0030 c2b); the shared PolygonParser guarantees well-formed
// WKT, so this only fires defensively — mapped to a clean 400 rather than a 500.
const PRISMA_RAW_QUERY_FAILED = "P2010";

// Prisma's "record required but not found" code, raised by update()/delete()
// when the target row vanished (e.g. a concurrent delete). Surfaced as 404.
const PRISMA_RECORD_NOT_FOUND = "P2025";

@Injectable()
export class GeofencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List geofences with optional type / customerId filters, a whitelisted
   * sort, and pagination. `total` reflects the filtered count so the UI can
   * render correct "Showing M–N of T" copy.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest first by
   * createdAt — matching every other list surface. The `id` secondary
   * tiebreaker (when createdAt is primary) or the `createdAt` secondary (for
   * any other primary) keeps paginated results deterministic.
   *
   * `skip` / `take` are clamped to safe bounds (LIST_TAKE_MAX = 200) as
   * defense-in-depth even though the controller already validated them.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    type,
    customerId,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    type?: GeofenceType[];
    customerId?: string;
    sortBy?: GeofenceSortColumn;
    sortDir?: GeofenceSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count so
    // `total` matches what findMany would return at skip=0/take=∞. Empty
    // arrays should not produce `in: []` (which would match zero rows) — the
    // schema's csvEnum normalizes those to undefined, but a belt-and-braces
    // check keeps the service robust against a future direct caller. customerId
    // is a scalar equality filter; an unknown id naturally yields an empty set.
    const where: Prisma.GeofenceWhereInput = {
      ...(type && type.length > 0 ? { type: { in: type } } : {}),
      ...(customerId ? { customerId } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-breaker
    // on createdAt (or id, when createdAt itself is the primary) so paginated
    // results are stable across requests. Same shape as the other services.
    const orderBy: Prisma.GeofenceOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.GeofenceOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.GeofenceOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.GeofenceOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.geofence.findMany({ skip: safeSkip, take: safeTake, where, orderBy }),
      this.prisma.geofence.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one geofence by id. Returns `null` when not found rather than
   * throwing, so the controller shapes the 404 and the service stays usable
   * from other modules without exception handling for the not-found path
   * (the future G5 status-query wiring will fetch a stored fence by id).
   */
  async findById(id: string): Promise<Geofence | null> {
    return this.prisma.geofence.findUnique({ where: { id } });
  }

  /**
   * Fetch one geofence by id or throw NotFoundException (HTTP 404). Convenience
   * wrapper for the controller's GET /:id handler; the message echoes the id so
   * an operator chasing a bad URL sees exactly which id missed. Mirror of
   * CustomersService.getById.
   */
  async getById(id: string): Promise<Geofence> {
    const fence = await this.findById(id);
    if (!fence) {
      throw new NotFoundException(`Geofence ${id} not found`);
    }
    return fence;
  }

  /**
   * Create a Geofence. `createdById` is supplied by the controller from the
   * authenticated session, never the client (the schema's `.strict()` rejects
   * it). The service inserts ONLY the canonical `boundaryWkt` (from the shared
   * PolygonParser) plus name/type/FKs — the `geometry(Polygon,4326)` column is
   * GENERATED in the database from `boundaryWkt`, so Prisma must never write it
   * (and the generated client does not expose it).
   *
   * Validity (ADR-0030 c2): Zod already rejected malformed input, and the
   * generated column would reject structurally-broken WKT at insert. The third
   * layer — the `ST_IsValid` gate below — rejects a SELF-INTERSECTING (bowtie)
   * ring: syntactically valid WKT that `ST_GeomFromText` accepts but
   * `ST_Contains` (T5/G5) would misclassify forever. It runs BEFORE the write.
   *
   * The type/ownership invariant (CUSTOMER_SITE ⇔ customerId) was enforced by
   * the create schema's superRefine; a stale-but-cuid-shaped customerId is
   * caught here as Prisma P2003 → 400.
   */
  async create(input: CreateGeofenceInput, createdById: string): Promise<Geofence> {
    await this.assertValidRing(input.boundary.wkt);

    const data: Prisma.GeofenceUncheckedCreateInput = {
      name: input.name,
      type: input.type,
      boundaryWkt: input.boundary.wkt,
      customerId: input.customerId ?? null,
      createdById,
    };

    try {
      return await this.prisma.geofence.create({ data });
    } catch (error) {
      throw mapGeofenceWriteError(error, input.customerId ?? null);
    }
  }

  /**
   * Diff-PATCH a Geofence. Returns null when the row is not found (controller
   * maps to 404), mirroring CustomersService.update.
   *
   *   1. Fetch the existing row (null → controller 404).
   *   2. Re-run the type/ownership invariant against the MERGED shape: a PATCH
   *      that changes only `type` re-validates against the stored customerId,
   *      and a PATCH that changes only `customerId` against the stored type.
   *   3. If the boundary changed, re-run the ST_IsValid gate (same validity
   *      check as create).
   *   4. Let Prisma write only the touched fields. The service distinguishes
   *      "client provided null" (clear customerId) from "client did not
   *      mention" (leave it) via hasOwnProperty. P2025 → null (404); P2003 →
   *      400 (stale customerId).
   */
  async update(id: string, input: UpdateGeofenceInput): Promise<Geofence | null> {
    const existing = await this.prisma.geofence.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }

    const has = (key: keyof UpdateGeofenceInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    // Merged shape for the type/ownership invariant. `type` from the patch or
    // the stored row; `customerId` from the patch (honoring an explicit null)
    // or the stored row.
    const mergedType = input.type ?? existing.type;
    const mergedCustomerId = has("customerId") ? (input.customerId ?? null) : existing.customerId;
    const ownershipErrors = validateGeofenceOwnership({
      type: mergedType,
      customerId: mergedCustomerId,
    });
    if (ownershipErrors.length > 0) {
      throw new BadRequestException(ownershipErrors.join(" "));
    }

    // A PATCH that changes the boundary re-runs the same validity gate as create.
    if (input.boundary !== undefined) {
      await this.assertValidRing(input.boundary.wkt);
    }

    const data: Prisma.GeofenceUncheckedUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.boundary !== undefined && { boundaryWkt: input.boundary.wkt }),
      ...(has("customerId") && { customerId: input.customerId ?? null }),
    };

    try {
      return await this.prisma.geofence.update({ where: { id }, data });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_RECORD_NOT_FOUND
      ) {
        // Row vanished between the findUnique and the update — rare but
        // possible under a concurrent delete. Map to null → controller 404.
        return null;
      }
      throw mapGeofenceWriteError(error, mergedCustomerId);
    }
  }

  /**
   * Hard delete. Returns true on delete, false when the geofence was not found
   * (P2025), so the controller shapes the 404.
   *
   * NOTE: nothing FKs INTO Geofence, so there is no inbound-reference delete
   * blocker here (no P2003 arm). The customer-side blocker — deleting a
   * Customer that OWNS a CUSTOMER_SITE fence — is handled by CustomersService's
   * EXISTING P2003 → 409 arm (Geofence.customerId is onDelete: Restrict), with
   * NO change to CustomersService (ADR-0030 c4).
   */
  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.geofence.delete({ where: { id } });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_RECORD_NOT_FOUND
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * The `ST_IsValid` pre-write gate (ADR-0030 commitment 2). Runs
   * `SELECT ST_IsValid(ST_GeomFromText($1, 4326))` with the boundary WKT BOUND
   * as a parameter (the same no-injection discipline the T5 query follows —
   * the WKT is never string-interpolated). A self-intersecting bowtie ring is
   * syntactically valid WKT (ST_GeomFromText accepts it, the generated column
   * would store it) but `ST_IsValid` returns false; this rejects it as HTTP
   * 400 BEFORE the write so a fence that would misclassify forever never lands.
   *
   * The try/catch maps a raw geometry-parse failure (P2010 — ST_GeomFromText
   * throwing on structurally-broken WKT) to a clean 400 too. In practice the
   * shared parser guarantees well-formed WKT, so that branch is defensive.
   */
  private async assertValidRing(wkt: string): Promise<void> {
    let rows: { valid: boolean | null }[];
    try {
      rows = await this.prisma.$queryRaw<{ valid: boolean | null }[]>`
        SELECT ST_IsValid(ST_GeomFromText(${wkt}, 4326)) AS valid`;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_RAW_QUERY_FAILED
      ) {
        throw new BadRequestException("Geofence boundary is not a parseable polygon.");
      }
      throw error;
    }

    if (rows[0]?.valid !== true) {
      throw new BadRequestException(
        "Geofence boundary is not a valid polygon: the ring is self-intersecting or degenerate.",
      );
    }
  }
}

// Translate a Prisma write error into the HTTP-facing exception. A P2003 on a
// Geofence write is a stale FK: name `customerId` (the client-controlled FK)
// in the 400 per docs/runbook/api-error-mapping.md; the `createdById` branch is
// the defense-in-depth "your session user vanished" case. Non-P2003 errors
// pass through unchanged (Nest renders them as 500). Mirror of the Jobs
// P2003-on-create mapping.
function mapGeofenceWriteError(error: unknown, customerId: string | null): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_FK_VIOLATION) {
    const meta = error.meta as { field_name?: string; constraint?: string } | undefined;
    const fieldName = String(meta?.field_name ?? meta?.constraint ?? "");
    if (fieldName.toLowerCase().includes("createdby")) {
      return new BadRequestException("Authenticated user no longer exists; sign in again.");
    }
    // The only client-controlled FK is customerId; name it.
    return new BadRequestException(`Customer ${customerId ?? ""} does not exist.`);
  }
  return error;
}
