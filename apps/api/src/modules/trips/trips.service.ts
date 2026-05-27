import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type Trip, type TripStatus } from "@prisma/client";

import type {
  CreateTripInput,
  TripSortColumn,
  TripSortDir,
  UpdateTripInput,
} from "./trips.schemas";
import { isLegalTripStatusTransition, validateTripCrossFields } from "./trips.schemas";

// Re-export the schema-inferred input types so call sites (notably the
// controller and tests) can pull them from this module — the same
// convention DriversService follows.
export type { CreateTripInput, UpdateTripInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it. Same eslint
// override as the Vehicles and Drivers services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// Pagination defaults and bounds. Same `LIST_TAKE_` prefix as the
// Drivers service (the iter-6 kickoff named the convention explicitly).
// The take cap (200) matches the Drivers and Vehicles caps; the
// minimum take (1) prevents the degenerate count-only request through
// this endpoint.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Slim projection used by the list endpoint. The list page renders
// the vehicle's registration number and the driver's full name next
// to each trip row; pulling those two fields via Prisma `select` is
// cheaper than eager-loading the full Vehicle / Driver objects, and
// keeps the wire payload small as fleets grow. The detail endpoint
// uses the broader `findById` shape with full nested objects so the
// detail page can render every field.
//
// The Prisma `select` literal below is the runtime authority for what
// the list endpoint returns; the controller's TripListItem type
// (trips.controller.ts) shapes the wire response from this same
// select. When the two diverge, the controller's TypeScript type
// catches the drift at the call site rather than silently dropping
// fields.
const LIST_SELECT = {
  id: true,
  vehicleId: true,
  driverId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  startOdometerKm: true,
  endOdometerKm: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  vehicle: {
    select: {
      id: true,
      registrationNumber: true,
    },
  },
  driver: {
    select: {
      id: true,
      fullName: true,
    },
  },
} satisfies Prisma.TripSelect;

// The list item shape — derived from LIST_SELECT via Prisma's
// validator helper. Exported so the controller's response type and
// the tests can share the precise shape.
export type TripListItem = Prisma.TripGetPayload<{ select: typeof LIST_SELECT }>;

// The detail shape — full Trip + full nested Vehicle + full nested
// Driver. Both relations are required on every Trip (the schema's FK
// is NOT NULL), so the include never produces nulls for them.
const DETAIL_INCLUDE = {
  vehicle: true,
  driver: true,
} satisfies Prisma.TripInclude;

export type TripDetail = Prisma.TripGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: TripListItem[];
  total: number;
}

@Injectable()
export class TripsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List trips with optional filter / sort / pagination. The list
   * endpoint returns the slim projection (LIST_SELECT) so the wire
   * payload stays small even as fleets grow; the detail endpoint
   * uses findById with the broader DETAIL_INCLUDE shape.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * first by createdAt — matches the Drivers and Vehicles surfaces
   * and the iter-4 list-page convention. The `id` secondary tiebreaker
   * (when createdAt itself is the primary) or the `createdAt`
   * secondary (when any other column is primary) is preserved so
   * paginated results are deterministic — without it, two rows with
   * identical primary sort values can flip between page loads and
   * either duplicate or skip a row. `startedAt` and `endedAt` are
   * nullable; Prisma's default null-ordering sorts nulls last in asc
   * and first in desc, which is the right shape for "most recently
   * started first" (planned trips with no start time slide to the end
   * of a desc sort, where they make sense as "not yet started").
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListTripsQuerySchema`, but the service is also
   * called from inside other modules' code paths in future slices
   * (e.g., a "trips for this driver" sidebar on the driver detail
   * page), and a clamp here ensures the database is never asked for
   * an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    vehicleId,
    driverId,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: TripStatus[];
    vehicleId?: string;
    driverId?: string;
    sortBy?: TripSortColumn;
    sortDir?: TripSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count
    // so `total` matches what findMany would return at skip=0/take=∞.
    // Empty arrays should not produce `in: []` (which would match zero
    // rows in Prisma) — the schema's csvEnum normalizes those to
    // `undefined`, but a belt-and-braces check here keeps the service
    // robust against any future direct caller that doesn't go through
    // the schema. vehicleId / driverId are scalar equality filters; an
    // unknown id naturally produces an empty result set, which is the
    // right UX for "trips for this vehicle" URLs that survive a
    // deleted vehicle (when soft-delete or block-when-referenced lands
    // per the tech-debt entry on cross-aggregate deletes).
    const where: Prisma.TripWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(vehicleId ? { vehicleId } : {}),
      ...(driverId ? { driverId } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-
    // breaker on createdAt (or id, when createdAt itself is the
    // primary) so paginated results are stable across requests.
    const orderBy: Prisma.TripOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.TripOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.TripOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.TripOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: LIST_SELECT,
      }),
      this.prisma.trip.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one trip by id with the related Vehicle and Driver
   * eager-loaded for the detail page. Returns `null` when not found
   * rather than throwing, so the controller can shape the 404 response
   * and the service stays usable from other modules without exception
   * handling for the not-found path.
   *
   * The eager include is the contract under test: the iter-8 detail
   * page expects both nested objects to be present, and Prisma's
   * required-FK guarantees they are. A refactor that changes the
   * include shape (e.g., dropping `driver` to a slim `select`) would
   * need to update both the service-level test and the controller-
   * level response type in the same commit.
   */
  async findById(id: string): Promise<TripDetail | null> {
    return this.prisma.trip.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
  }

  /**
   * Plain Trip lookup without the eager relations — exposed for the
   * future iter-9 write path's PATCH route (which needs the existing
   * row but does not need to render the nested objects) and for tests
   * that want to assert the raw row shape. The Phase-1 service
   * surface is small enough that exposing both shapes is cheaper than
   * an internal-only flag on findById.
   */
  async findByIdRaw(id: string): Promise<Trip | null> {
    return this.prisma.trip.findUnique({ where: { id } });
  }

  /**
   * Create a Trip. `createdById` is supplied by the controller from
   * the authenticated session, not by the client. CreateTripSchema's
   * `.strict()` keeps `createdById` (and any other unknown key) off
   * the wire; the service trusts that and uses only fields from
   * `CreateTripInput`.
   *
   * Cross-field rules (IN_PROGRESS requires startedAt + startOdometerKm;
   * COMPLETED requires all four start/end fields and end >= start) are
   * already validated by the schema's superRefine for the create path,
   * so this method does not re-run them — re-validation here would
   * change nothing on a happy path and only obscure error origin on
   * the failure path.
   *
   * P2003 (foreign-key constraint failure) on insert means the
   * `vehicleId` or `driverId` points at a deleted (or never-existed)
   * row. We name the failing FK in the BadRequest message so the
   * operator knows whether to re-pick the vehicle or the driver. The
   * mapping is HTTP 400 (not 409) because the request body itself is
   * the problem — an operator submitting a stale form whose selected
   * vehicle was deleted between page load and submit gets a clear
   * error about the body shape, not a phantom conflict.
   */
  async create(input: CreateTripInput, createdById: string): Promise<TripDetail> {
    const data: Prisma.TripUncheckedCreateInput = {
      vehicleId: input.vehicleId,
      driverId: input.driverId,
      status: input.status,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      startOdometerKm: input.startOdometerKm ?? null,
      endOdometerKm: input.endOdometerKm ?? null,
      notes: input.notes ?? null,
      createdById,
    };

    try {
      return await this.prisma.trip.create({ data, include: DETAIL_INCLUDE });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        // Prisma surfaces the failing constraint name in
        // `error.meta?.field_name` (e.g. "Trip_vehicleId_fkey"). Walk
        // both candidate ids before deciding which to call out — a
        // request that bundles both a stale vehicleId and a stale
        // driverId would otherwise blame only the first. The DB tells
        // us which one; the message echoes back the literal id so the
        // operator can search their bookmark history.
        const fieldName = String(
          (error.meta as { field_name?: string; constraint?: string } | undefined)?.field_name ??
            (error.meta as { field_name?: string; constraint?: string } | undefined)?.constraint ??
            "",
        );
        if (fieldName.toLowerCase().includes("vehicle")) {
          throw new BadRequestException(`Vehicle "${input.vehicleId}" does not exist.`);
        }
        if (fieldName.toLowerCase().includes("driver")) {
          throw new BadRequestException(`Driver "${input.driverId}" does not exist.`);
        }
        if (fieldName.toLowerCase().includes("createdby")) {
          // Defense-in-depth: the controller pulls createdById from the
          // session, so this should never fire. If it does, the
          // session points at a deleted user — a recoverable error
          // best surfaced as 400 with a clear hint rather than a 500.
          throw new BadRequestException(
            `Authenticated user "${createdById}" no longer exists; sign in again.`,
          );
        }
        // Unknown FK name: surface a generic message rather than
        // throwing the raw Prisma error.
        throw new BadRequestException(
          `One of vehicleId or driverId references a record that does not exist.`,
        );
      }
      throw error;
    }
  }

  /**
   * Diff-PATCH a Trip. Mirrors DriversService.update in shape:
   *
   *   1. Fetch the existing row (404 if missing, surfaced as
   *      NotFoundException).
   *   2. Build the merged shape (existing row with the patch applied).
   *   3. Apply the legal-status-transition guard against the merged
   *      shape (PLANNED → IN_PROGRESS → COMPLETED, with CANCELLED
   *      reachable from any non-terminal state). Self-transitions are
   *      legal so a no-op PATCH does not fail.
   *   4. Run validateTripCrossFields on the merged shape — Zod's
   *      schema-level superRefine cannot do this because the schema
   *      only sees the partial body; a PATCH that sets
   *      `status: "COMPLETED"` without re-sending the timing fields
   *      must be validated against what the row would look like after
   *      the update.
   *   5. Let Prisma do the write. P2003 on update is rare (only happens
   *      if the patch sets vehicleId/driverId to a stale value) and is
   *      surfaced as the same BadRequestException as create.
   *
   * Returns the trip's DETAIL_INCLUDE shape so the controller can
   * respond with the same shape that GET /api/v1/trips/:id returns.
   */
  async update(id: string, input: UpdateTripInput): Promise<TripDetail> {
    const existing = await this.prisma.trip.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Trip "${id}" not found.`);
    }

    // Build the merged shape: existing row, then the patch keys layered
    // on top. We use `hasOwnProperty` so an explicit `null` in the
    // patch (e.g., clearing startedAt by setting it to null) is treated
    // as a real value change rather than "field omitted".
    const has = (key: keyof UpdateTripInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    const merged = {
      status: (has("status") ? input.status : existing.status) as TripStatus,
      startedAt: has("startedAt") ? (input.startedAt ?? null) : existing.startedAt,
      endedAt: has("endedAt") ? (input.endedAt ?? null) : existing.endedAt,
      startOdometerKm: has("startOdometerKm")
        ? (input.startOdometerKm ?? null)
        : existing.startOdometerKm,
      endOdometerKm: has("endOdometerKm") ? (input.endOdometerKm ?? null) : existing.endOdometerKm,
    };

    // Legal-status-transition guard. Only enforce when the patch
    // actually changes status — a PATCH that re-sends the current
    // status as part of a larger update should not fail at this
    // guard. The matrix already treats self-transitions as legal, but
    // routing through `has("status")` first keeps the error message
    // accurate ("can't go from X to Y" only fires when X actually went
    // to Y).
    if (has("status") && input.status !== undefined && input.status !== existing.status) {
      if (!isLegalTripStatusTransition(existing.status, input.status)) {
        throw new BadRequestException(
          `Illegal status transition: ${existing.status} → ${input.status}.`,
        );
      }
    }

    // Cross-field validation against the merged shape.
    const crossFieldErrors = validateTripCrossFields(merged);
    if (crossFieldErrors.length > 0) {
      throw new BadRequestException(crossFieldErrors.join(" "));
    }

    const data: Prisma.TripUpdateInput = {
      ...(has("vehicleId") &&
        input.vehicleId !== undefined && { vehicle: { connect: { id: input.vehicleId } } }),
      ...(has("driverId") &&
        input.driverId !== undefined && { driver: { connect: { id: input.driverId } } }),
      ...(has("status") && input.status !== undefined && { status: input.status }),
      ...(has("startedAt") && { startedAt: input.startedAt ?? null }),
      ...(has("endedAt") && { endedAt: input.endedAt ?? null }),
      ...(has("startOdometerKm") && { startOdometerKm: input.startOdometerKm ?? null }),
      ...(has("endOdometerKm") && { endOdometerKm: input.endOdometerKm ?? null }),
      ...(has("notes") && { notes: input.notes ?? null }),
    };

    // Iter 11: when a Trip *transitions* into COMPLETED (i.e., the
    // existing row was not already COMPLETED and the patch flips it
    // to COMPLETED), the referenced Vehicle's `odometerCurrentKm`
    // should advance to the trip's `endOdometerKm` — but only when
    // that reading is strictly greater than the vehicle's current
    // value. The `>` check (not `>=`) avoids a no-op write; the
    // `> current` clause prevents a backdated correction trip from
    // moving the vehicle's odometer backwards. The two writes (trip
    // row and vehicle row) run inside a single Prisma interactive
    // transaction so a mid-flight database failure cannot leave the
    // trip COMPLETED with a stale vehicle odometer, nor the vehicle
    // bumped without its triggering trip having been saved.
    //
    // Per the legal-status-transition matrix
    // (TRIP_STATUS_TRANSITIONS), the canonical bump path is
    // IN_PROGRESS → COMPLETED. PLANNED → COMPLETED and CANCELLED →
    // COMPLETED are not legal transitions and are already rejected
    // by the guard above, so the bump path is reached only via
    // IN_PROGRESS → COMPLETED. The "from === to" self-transition
    // (COMPLETED → COMPLETED) is permitted by the matrix but is a
    // no-op for the odometer: we only bump when the status actually
    // *changed* into COMPLETED, so a second PATCH that re-sends
    // status=COMPLETED on an already-COMPLETED row is idempotent.
    //
    // The vehicle-bump effect — "once forward, stays forward" — is
    // intentional and documented in the iter-11 kickoff: a later
    // COMPLETED → CANCELLED (which is itself disallowed by the
    // matrix today) or a Trip deletion does NOT roll the vehicle's
    // odometer back. The compensating action is an operator
    // manually editing the Vehicle's odometerCurrentKm via the
    // Vehicle edit form; see the Odometer entry in docs/glossary.md.
    const isCompletedTransition =
      has("status") &&
      input.status === "COMPLETED" &&
      existing.status !== "COMPLETED" &&
      merged.endOdometerKm !== null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updatedTrip = await tx.trip.update({
          where: { id },
          data,
          include: DETAIL_INCLUDE,
        });

        if (isCompletedTransition && merged.endOdometerKm !== null) {
          const vehicle = await tx.vehicle.findUniqueOrThrow({
            where: { id: updatedTrip.vehicleId },
            select: { odometerCurrentKm: true },
          });
          if (merged.endOdometerKm > vehicle.odometerCurrentKm) {
            await tx.vehicle.update({
              where: { id: updatedTrip.vehicleId },
              data: { odometerCurrentKm: merged.endOdometerKm },
            });
            // Refresh the eager-included Vehicle on the returned
            // trip so callers (controllers, tests) observe the
            // newly bumped value without a follow-up read. Cheaper
            // than a second `findUnique({ include: DETAIL_INCLUDE })`
            // because we already know the new value.
            updatedTrip.vehicle = {
              ...updatedTrip.vehicle,
              odometerCurrentKm: merged.endOdometerKm,
            };
          }
        }

        return updatedTrip;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        // Row vanished between the findUnique and the update — rare
        // but possible if a concurrent DELETE landed in between. Map
        // to NotFoundException so the controller surfaces 404.
        throw new NotFoundException(`Trip "${id}" not found.`);
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        // Same FK mapping as create. Reachable only when the patch
        // sets vehicleId or driverId to a stale id.
        const fieldName = String(
          (error.meta as { field_name?: string; constraint?: string } | undefined)?.field_name ??
            (error.meta as { field_name?: string; constraint?: string } | undefined)?.constraint ??
            "",
        );
        if (fieldName.toLowerCase().includes("vehicle")) {
          throw new BadRequestException(`Vehicle "${input.vehicleId ?? ""}" does not exist.`);
        }
        if (fieldName.toLowerCase().includes("driver")) {
          throw new BadRequestException(`Driver "${input.driverId ?? ""}" does not exist.`);
        }
        throw new BadRequestException(
          `One of vehicleId or driverId references a record that does not exist.`,
        );
      }
      throw error;
    }
  }

  /**
   * Hard delete a Trip. No referencing slice exists in Phase 1 (fuel
   * logs and GPS pings, which will reference Trip, arrive in Phase 2),
   * so a P2003 mapping is not needed here today. P2025 (delete
   * targets a non-existent row) maps to NotFoundException.
   *
   * Returns void on success; the controller responds 204 No Content.
   */
  async delete(id: string): Promise<void> {
    try {
      await this.prisma.trip.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new NotFoundException(`Trip "${id}" not found.`);
      }
      throw error;
    }
  }
}
