import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma, type Site, type SiteKind } from "@prisma/client";

import type {
  CreateSiteInput,
  SiteSortColumn,
  SiteSortDir,
  UpdateSiteInput,
} from "./sites.schemas";

// Re-export the schema-inferred types so call sites that import
// { CreateSiteInput, UpdateSiteInput } from this module keep working without
// churn — the authoritative shape lives next to the schema in sites.schemas.ts.
// Same pattern CustomersService follows.
export type { CreateSiteInput, UpdateSiteInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata;
// the class reference must remain a value import at runtime so the DI container
// can resolve it. Same eslint override as the Customers/Drivers services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: Site[];
  total: number;
}

// Prisma's FK-constraint violation code. A Site referenced by a Trip's
// pickupSiteId / dropoffSiteId (onDelete: Restrict, declared on Trip per
// ADR-0047 c4) cannot be deleted; Prisma raises P2003, which `delete()` maps to
// HTTP 409 naming the referencing-trip count — the house delete-blocker, mirror
// of the Vehicle / Driver surfaces.
const PRISMA_FK_VIOLATION = "P2003";

// Prisma's "record required but not found" code, raised when delete targets a
// non-existent row. Mapped to a 404 (the controller shapes it).
const PRISMA_NOT_FOUND = "P2025";

// Pagination defaults and bounds. Names match the Customers service so the two
// surfaces stay grep-symmetric. The take cap (200) matches the other list
// endpoints; the minimum take (1) prevents a degenerate count-only request.
//
// LIST_TAKE_MAX is defense-in-depth: the controller validates `take` against
// the same ceiling via ListSitesQuerySchema, but the service is also reachable
// from future internal callers (the W4 Trip dispatch path will fetch a Site by
// id to validate a pickup/drop-off), and a clamp here ensures the database is
// never asked for an unbounded result regardless of how the call site reaches
// the service.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List sites. Supports filtering by kind, sorting by a whitelisted column,
   * and pagination. `total` reflects the filtered count so the UI can render
   * correct "Showing M–N of T" copy and disable next-page at the edge.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest first by
   * createdAt. The `id` secondary tiebreaker (when createdAt is the primary) or
   * the `createdAt` secondary (when any other column is primary) is preserved
   * so paginated results are deterministic across page loads. Same shape as
   * CustomersService.list.
   *
   * IMPORTANT: this NEVER selects the generated `geometry` column — Prisma does
   * not expose it (declared Unsupported in schema.prisma), so a default
   * `findMany` returns only the native scalar columns, which is exactly what we
   * want (the map surface reads latitude/longitude, not the WKB blob).
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    kind,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    kind?: SiteKind[];
    sortBy?: SiteSortColumn;
    sortDir?: SiteSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count so
    // `total` matches what findMany would return at skip=0/take=∞. An empty
    // `kind` array should not produce `in: []` (which would match zero rows);
    // the schema's csvEnum normalizes those to `undefined`, and this guard
    // keeps the service robust against a future direct caller.
    const where: Prisma.SiteWhereInput = {
      ...(kind && kind.length > 0 ? { kind: { in: kind } } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-breaker
    // on createdAt (or id, when createdAt itself is the primary) so paginated
    // results are stable across requests. Same shape as CustomersService.list.
    const orderBy: Prisma.SiteOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.SiteOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.SiteOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.SiteOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.site.findMany({ skip: safeSkip, take: safeTake, where, orderBy }),
      this.prisma.site.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one site by id. Returns `null` when not found rather than throwing,
   * so the controller can shape the 404 response and the service stays usable
   * from other modules without exception handling for the not-found path. (The
   * W4 Trip dispatch path will call this to validate a pickup/drop-off Site.)
   */
  async findById(id: string): Promise<Site | null> {
    return this.prisma.site.findUnique({ where: { id } });
  }

  /**
   * Create a Site. `createdById` is supplied by the controller from the
   * authenticated session, not by the client. The create schema rejects
   * unknown keys via `.strict()`, but the service does not depend on that — it
   * writes only the fields from CreateSiteInput.
   *
   * The service writes ONLY the native `latitude`/`longitude` floats — never
   * `geometry`. That column is GENERATED ALWAYS AS (...) STORED in the database
   * (ADR-0047 c4) and Prisma does not even expose it (Unsupported), so it
   * cannot drift from the floats and there is nothing to insert.
   *
   * Site has NO unique columns (unlike Customer.panNumber), so there is no
   * P2002 path here — a create either succeeds or fails on the createdById FK
   * (a caller bug, surfaced as 500), never on a duplicate.
   */
  async create(input: CreateSiteInput, createdById: string): Promise<Site> {
    const data: Prisma.SiteUncheckedCreateInput = {
      name: input.name,
      kind: input.kind,
      latitude: input.latitude,
      longitude: input.longitude,
      address: input.address ?? null,
      contactName: input.contactName ?? null,
      contactPhone: input.contactPhone ?? null,
      createdById,
    };

    return this.prisma.site.create({ data });
  }

  /**
   * Partial update. The controller's validation guarantees the body is
   * non-empty (`.refine` on UpdateSiteSchema) and contains only mutable fields
   * (`.strict()`). The service distinguishes "client provided null" (clear the
   * field) from "client did not mention" (leave the field alone) via
   * hasOwnProperty for the nullable optional fields. Mirror of how
   * CustomersService.update handles contactPerson.
   *
   * latitude / longitude / kind / name are required-on-create but freely
   * mutable on PATCH (a mis-dropped pin gets corrected); they use `!== undefined`
   * because they are non-nullable columns (you cannot clear a pin's latitude to
   * null). Returns null when the site is not found, mirroring findById's shape
   * so the controller can shape the 404.
   */
  async update(id: string, input: UpdateSiteInput): Promise<Site | null> {
    const existing = await this.prisma.site.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }

    const data: Prisma.SiteUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.kind !== undefined && { kind: input.kind }),
      ...(input.latitude !== undefined && { latitude: input.latitude }),
      ...(input.longitude !== undefined && { longitude: input.longitude }),
      ...(Object.prototype.hasOwnProperty.call(input, "address") && {
        address: input.address ?? null,
      }),
      ...(Object.prototype.hasOwnProperty.call(input, "contactName") && {
        contactName: input.contactName ?? null,
      }),
      ...(Object.prototype.hasOwnProperty.call(input, "contactPhone") && {
        contactPhone: input.contactPhone ?? null,
      }),
    };

    return this.prisma.site.update({ where: { id }, data });
  }

  /**
   * Hard delete. Returns true on delete, false when the site was not found, so
   * the controller can shape the 404 response.
   *
   * Delete-blocker (ADR-0047 c4): Trip.pickupSiteId / Trip.dropoffSiteId declare
   * onDelete: Restrict, so Prisma raises P2003 when the operator tries to delete
   * a Site still referenced by any trip. We count the referencing rows (a trip
   * may reference the same site as EITHER pickup or drop-off, hence the OR) and
   * translate that into ConflictException (HTTP 409) with the count in the
   * message, so the operator sees a clear "N trips reference this site" message
   * rather than a 500 — the same shape the Vehicle / Driver delete-blockers use.
   */
  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.site.delete({ where: { id } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === PRISMA_NOT_FOUND) {
          return false;
        }
        if (error.code === PRISMA_FK_VIOLATION) {
          const tripCount = await this.prisma.trip.count({
            where: { OR: [{ pickupSiteId: id }, { dropoffSiteId: id }] },
          });
          throw new ConflictException(
            `Cannot delete site: ${tripCount} trip${tripCount === 1 ? "" : "s"} reference this site.`,
          );
        }
      }
      throw error;
    }
  }
}
