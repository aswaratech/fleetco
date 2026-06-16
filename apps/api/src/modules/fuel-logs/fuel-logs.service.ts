import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";

import type {
  CreateFuelLogInput,
  FuelLogSortColumn,
  FuelLogSortDir,
  UpdateFuelLogInput,
} from "./fuel-logs.schemas";

// Re-export the schema-inferred input types so call sites (notably
// the controller and tests) can pull them from this module — the
// same convention TripsService / CustomersService / JobsService
// follow.
export type { CreateFuelLogInput, UpdateFuelLogInput };

// PrismaService is injected by NestJS via TypeScript's
// emitDecoratorMetadata (see apps/api/tsconfig.json); the class
// reference must remain a value import at runtime so the DI container
// can resolve it. Same eslint override as the Vehicles / Drivers /
// Trips / Customers / Jobs services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// DriverScopeService is injected (value import, same eslint override). It is the
// auth module's own-record resolver; `Actor` is the {userId, role} principal the
// controller threads in so the service can scope a DRIVER to their own fuel-log
// entries (ADR-0034 c4). A non-DRIVER actor imposes no restriction.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DriverScopeService, type Actor } from "../auth/driver-scope.service";

// Pagination defaults and bounds. Same `LIST_TAKE_` prefix as every
// other vertical-slice service (the iter-6 kickoff named the
// convention explicitly and every subsequent slice has matched it).
// The take cap (200) matches the precedent; the minimum take (1)
// prevents the degenerate count-only request through this endpoint.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Slim projection used by the list endpoint. The list page renders
// the date, the vehicle's registration number (mono badge), the
// liters / price / total triplet, and link-throughs to the related
// trip (when present). Pulling only those fields via a nested Prisma
// `select` is cheaper than eager-loading the full Vehicle and Trip
// objects, and keeps the wire payload small as the book grows. The
// detail endpoint uses the broader DETAIL_INCLUDE shape with the full
// nested Vehicle and Trip objects so the detail page can render every
// field and deep-link back to /vehicles/<id> and /trips/<id>.
//
// The Prisma `select` literal below is the runtime authority for what
// the list endpoint returns; the FuelLogListItem type derived from it
// shapes the wire response from this same select. When the two
// diverge, TypeScript catches the drift at the call site rather than
// silently dropping fields.
const LIST_SELECT = {
  id: true,
  vehicleId: true,
  tripId: true,
  date: true,
  litersMl: true,
  pricePerLiterPaisa: true,
  totalCostPaisa: true,
  odometerReadingKm: true,
  station: true,
  receiptNumber: true,
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
  // Trip relation is nullable on FuelLog (the FK is `tripId String?`);
  // Prisma's select on a nullable relation returns the selected shape
  // or null. We project a minimal id-only handle (Trip has no
  // human-readable number on Phase-1 Trips today — the glossary entry
  // for Trip notes this; if a future iter adds a tripNumber, this
  // select is the file to update alongside the web detail page).
  trip: {
    select: {
      id: true,
    },
  },
} satisfies Prisma.FuelLogSelect;

// The list item shape — derived from LIST_SELECT via Prisma's
// validator helper. Exported so the controller's response type and
// the tests can share the precise shape. Same pattern as
// JobsService.JobListItem.
export type FuelLogListItem = Prisma.FuelLogGetPayload<{ select: typeof LIST_SELECT }>;

// The detail shape — full FuelLog + full nested Vehicle + full nested
// Trip (when present). The Vehicle relation is required on every
// FuelLog (the schema's FK is NOT NULL), so the include never
// produces null for it. The Trip relation IS nullable; Prisma returns
// null for it when `tripId` is null, and the detail page renders the
// "Trip" section conditionally on that.
const DETAIL_INCLUDE = {
  vehicle: true,
  trip: true,
} satisfies Prisma.FuelLogInclude;

export type FuelLogDetail = Prisma.FuelLogGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: FuelLogListItem[];
  total: number;
}

@Injectable()
export class FuelLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly driverScope: DriverScopeService,
  ) {}

  /**
   * List fuel logs with optional filter / sort / pagination. The list
   * endpoint returns the slim projection (LIST_SELECT) so the wire
   * payload stays small even as the book grows; the detail endpoint
   * uses getById with the broader DETAIL_INCLUDE shape.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * fill first by `date`. `date` is the natural sort for a fuel
   * ledger ("when was the most recent fill?"), and the schema's
   * `(date desc)` partial index makes the default cheap.
   *
   * `vehicleId` and `tripId` are scalar equality filters; unknown ids
   * naturally produce empty result sets, which is the right UX for
   * "fuel for this vehicle / trip" URLs that survive a deleted
   * referent (although the schema's onDelete: Restrict prevents the
   * vehicle case today, and the iter-20 write path will surface a
   * friendly 409 on the trip case when the time comes). `startDate`
   * and `endDate` are inclusive bounds on the `date` column.
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListFuelLogsQuerySchema`, but the service is
   * also called from inside other modules' code paths in future
   * slices (a "recent fuel" sidebar on the Vehicle detail page, for
   * example), and a clamp here ensures the database is never asked
   * for an unbounded result.
   */
  async list(
    {
      skip = 0,
      take = LIST_TAKE_DEFAULT,
      vehicleId,
      tripId,
      startDate,
      endDate,
      sortBy = "date",
      sortDir = "desc",
    }: {
      skip?: number;
      take?: number;
      vehicleId?: string;
      tripId?: string;
      startDate?: Date;
      endDate?: Date;
      sortBy?: FuelLogSortColumn;
      sortDir?: FuelLogSortDir;
    },
    actor: Actor,
  ): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count
    // so `total` matches what findMany would return at skip=0/take=∞.
    // Each filter is included only when present so omitted filters
    // don't generate noisy `where` clauses Prisma has to optimize
    // around.
    const dateRange: Prisma.DateTimeFilter = {};
    if (startDate) dateRange.gte = startDate;
    if (endDate) dateRange.lte = endDate;
    const hasDateRange = startDate !== undefined || endDate !== undefined;

    const where: Prisma.FuelLogWhereInput = {
      ...(vehicleId ? { vehicleId } : {}),
      ...(tripId ? { tripId } : {}),
      ...(hasDateRange ? { date: dateRange } : {}),
      // DRIVER own-record scope (ADR-0034 c4): a driver sees ONLY the fuel logs
      // THEY created (createdById = their user id — server-set on create, so it
      // is the precise "my entries" predicate and needs no Driver lookup). Last
      // spread so a client filter cannot widen it. Non-DRIVER → no restriction.
      ...(actor.role === UserRole.DRIVER ? { createdById: actor.userId } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-
    // breaker on id so paginated results are stable across requests
    // even when two rows share the primary sort value (e.g., two
    // fills logged with the same `date` value). Same pattern as the
    // Jobs / Trips orderBy construction.
    const orderBy: Prisma.FuelLogOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.FuelLogOrderByWithRelationInput,
      { id: sortDir } as Prisma.FuelLogOrderByWithRelationInput,
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.fuelLog.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: LIST_SELECT,
      }),
      this.prisma.fuelLog.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one fuel log by id with the related Vehicle and Trip
   * eager-loaded for the detail page. The controller wraps a null
   * return into NotFoundException so this method stays usable from
   * other modules without exception handling for the not-found path
   * — same shape the Jobs / Customers services use. Returns
   * FuelLogDetail (with Vehicle always present, Trip nullable).
   */
  async findById(id: string): Promise<FuelLogDetail | null> {
    return this.prisma.fuelLog.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
  }

  /**
   * Fetch one fuel log by id with the relations eager-loaded, or
   * throw NotFoundException. Convenience wrapper used by the
   * controller's GET /:id handler so the 404 shape lives in the
   * service rather than being duplicated at every controller method.
   * The NotFoundException message echoes the id so an operator who
   * mistyped a URL sees what they asked for. Mirror of
   * JobsService.getById.
   */
  async getById(id: string, actor: Actor): Promise<FuelLogDetail> {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException(`Fuel log ${id} not found`);
    }
    // DRIVER own-record gate (ADR-0034 c4): a driver may read ONLY their own
    // entries. A foreign row → 404 (existence-hiding), uniform with a missing id.
    if (actor.role === UserRole.DRIVER && row.createdById !== actor.userId) {
      throw new NotFoundException(`Fuel log ${id} not found`);
    }
    return row;
  }

  /**
   * Create a FuelLog. `createdById` is supplied by the controller
   * from the authenticated session, not by the client — same
   * convention as every other write-path service. `CreateFuelLogSchema.strict()`
   * keeps `createdById` (and `totalCostPaisa`, and any other unknown
   * key) off the wire; the service trusts that and uses only fields
   * from `CreateFuelLogInput`.
   *
   * `totalCostPaisa` is DERIVED here from `litersMl *
   * pricePerLiterPaisa / 1000`, rounded by `Math.round` (half-up).
   * The `/1000` converts milliliters to liters (per the
   * money-as-minor-units rule mechanically extended to volume; see
   * CLAUDE.md §"Money & units"). Half-up rounding matches the
   * operator's mental model for cash receipts in Nepal and the
   * printed pump-receipts they audit against; banker's-rounding
   * alternatives were considered and rejected at the iter-20
   * kickoff. See the glossary entry's "iter-20" note for the
   * decision record.
   *
   * Cross-field rule (trip-vehicle consistency): when `tripId` is
   * present, the referenced Trip's `vehicleId` MUST match this fuel
   * log's `vehicleId`. The rationale: a fuel log paired with a trip
   * is making a claim about which trip consumed that fuel; a trip
   * for vehicle B cannot have consumed fuel pumped into vehicle A.
   * The check is service-layer (not a DB constraint) — same
   * precedent as the trip status-transition rules; the relationship
   * is small and changes faster than schema migrations are
   * comfortable to ship. On mismatch we throw BadRequestException
   * with the offending registration numbers named so the operator
   * understands the mismatch.
   *
   * FK validation (P2003): on a Prisma foreign-key violation, we
   * translate to BadRequestException with a per-field message
   * (`vehicleId` / `tripId` / `createdById`). HTTP 400 (not 409) per
   * the runbook — FK-on-create is a client-input error (the picker
   * referenced a deleted or invalid row), not a server-side
   * conflict. The error object's `meta.field_name` tells us which
   * FK; we route by lowercased substring match.
   *
   * Odometer monotonicity — RECORDED DECISION (non-monotonic by
   * design): a fuel log's `odometerReadingKm` is deliberately NOT
   * required to be >= the previous fill's reading for the same
   * vehicle, and there is intentionally no write-time guard here.
   * A hard reject would fight three legitimate realities: backdated
   * corrections (a receipt entered days late, out of order),
   * odometer swaps / replacements (a broken-odometer swap makes the
   * new reading genuinely LOWER than the old one), and the future
   * bulk-import path (which must accept historical rows in whatever
   * order they arrive). The soft signal that actually matters — a
   * per-vehicle km/L outlier — belongs with the future per-vehicle
   * fuel-efficiency report, which can surface a fill whose odometer
   * regresses as an informational warning; it does NOT belong on
   * this write path. This discharges the "Fuel-log odometer-
   * monotonicity check deferred" debt as option (b), the documented
   * decision — see docs/tech-debt.md (Paid-off) and the glossary's
   * "Fuel log" / "Odometer" entries.
   */
  async create(
    input: CreateFuelLogInput,
    createdById: string,
    actor: Actor,
  ): Promise<FuelLogDetail> {
    // DRIVER own-record scope (ADR-0034 c4): a driver may log fuel ONLY against
    // one of their OWN trips — which is also what defines "their vehicle" (the
    // vehicle on that trip; there is no standing Driver→Vehicle link). So a
    // driver-created fuel log MUST carry a tripId, and that trip must be theirs.
    // `createdById` is already the driver's user id (the controller sets it from
    // the session). resolveOwnDriverId also fails closed (403) for an unlinked
    // driver. For a non-DRIVER it returns null and this block is skipped.
    const ownDriverId = await this.driverScope.resolveOwnDriverId(actor);
    if (ownDriverId !== null) {
      if (!input.tripId) {
        throw new BadRequestException(
          "A driver fuel log must be paired with one of your own trips.",
        );
      }
      await this.assertTripOwnedByDriver(input.tripId, ownDriverId);
    }

    // Service-layer cross-field check before we even attempt the
    // insert: if the operator picked a trip that's for a different
    // vehicle, fail fast with a clear message naming both
    // registration numbers. We need a DB lookup of both the trip
    // and the vehicle, so the check lives here rather than in the
    // Zod schema.
    if (input.tripId) {
      await this.assertTripBelongsToVehicle(input.tripId, input.vehicleId);
    }

    // Derive totalCostPaisa from the request. See the rounding
    // rationale in the docblock above and CLAUDE.md §"Money & units".
    const totalCostPaisa = deriveTotalCostPaisa(input.litersMl, input.pricePerLiterPaisa);

    const data: Prisma.FuelLogUncheckedCreateInput = {
      vehicleId: input.vehicleId,
      tripId: input.tripId ?? null,
      date: input.date,
      litersMl: input.litersMl,
      pricePerLiterPaisa: input.pricePerLiterPaisa,
      totalCostPaisa,
      odometerReadingKm: input.odometerReadingKm ?? null,
      station: input.station ?? null,
      receiptNumber: input.receiptNumber ?? null,
      notes: input.notes ?? null,
      createdById,
    };

    try {
      return await this.prisma.fuelLog.create({ data, include: DETAIL_INCLUDE });
    } catch (error) {
      throw mapFuelLogWriteError(error, {
        vehicleId: input.vehicleId,
        tripId: input.tripId ?? null,
        createdById,
      });
    }
  }

  /**
   * Diff-PATCH a FuelLog. Mirrors JobsService.update / CustomersService.update
   * in shape:
   *
   *   1. Fetch the existing row (404 if missing, surfaced as
   *      NotFoundException). We need the existing row to compute
   *      the merged litersMl / pricePerLiterPaisa for the
   *      totalCostPaisa re-derivation and for the trip-vehicle
   *      consistency check.
   *
   *   2. If `tripId` is present in the PATCH (including explicit
   *      null), re-run the trip-vehicle consistency check against
   *      the MERGED shape (the patch's tripId paired with the
   *      EXISTING row's vehicleId — vehicleId is immutable on
   *      PATCH and so the existing value is the right comparison).
   *
   *   3. If either `litersMl` or `pricePerLiterPaisa` is present
   *      in the PATCH, recompute totalCostPaisa against the merged
   *      shape (current row + patch). A PATCH that touches only
   *      `pricePerLiterPaisa` re-derives totalCostPaisa against the
   *      stored `litersMl`. Same rounding rule as create — see
   *      `deriveTotalCostPaisa`.
   *
   *   4. Let Prisma do the write. P2003 → BadRequestException
   *      (only tripId can flip from null to non-null on PATCH;
   *      vehicleId is rejected at the schema layer). P2025 →
   *      NotFoundException (rare; only if a concurrent DELETE
   *      landed between step 1 and the update).
   *
   * Returns the fuel log's DETAIL_INCLUDE shape so the controller
   * can respond with the same shape that GET /api/v1/fuel-logs/:id
   * returns.
   *
   * `vehicleId` is not accepted by UpdateFuelLogSchema (the
   * `.strict()` + absence-from-shape rejects it). See the schema's
   * docblock and the iter-20 kickoff for the immutability
   * rationale.
   */
  async update(id: string, input: UpdateFuelLogInput, actor: Actor): Promise<FuelLogDetail> {
    const existing = await this.prisma.fuelLog.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Fuel log ${id} not found`);
    }

    // DRIVER own-record gate (ADR-0034 c4): a driver may edit ONLY their own
    // entries (createdById = their user id); a foreign row → 404 (existence-
    // hiding). If a driver re-pairs the log to a different trip, that trip must
    // also be theirs — re-asserted here, alongside the trip-vehicle consistency
    // rule that runs for everyone below.
    if (actor.role === UserRole.DRIVER) {
      if (existing.createdById !== actor.userId) {
        throw new NotFoundException(`Fuel log ${id} not found`);
      }
      if (Object.prototype.hasOwnProperty.call(input, "tripId") && input.tripId) {
        const ownDriverId = await this.driverScope.resolveOwnDriverId(actor);
        if (ownDriverId !== null) {
          await this.assertTripOwnedByDriver(input.tripId, ownDriverId);
        }
      }
    }

    const has = (key: keyof UpdateFuelLogInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    // Trip-vehicle consistency on the merged shape. vehicleId is
    // immutable on PATCH so the comparison value is the existing
    // row's vehicleId. tripId may be set, changed, or cleared
    // (nulled) on PATCH; we re-validate only when it's touched and
    // the new value is non-null (a null pairing has nothing to
    // mismatch against).
    if (has("tripId") && input.tripId) {
      await this.assertTripBelongsToVehicle(input.tripId, existing.vehicleId);
    }

    // Recompute totalCostPaisa whenever either factor is touched.
    // Same rounding rule as create. Documented at
    // deriveTotalCostPaisa and on the schema's UpdateFuelLogSchema
    // docblock.
    let totalCostPaisaPatch: number | undefined;
    if (has("litersMl") || has("pricePerLiterPaisa")) {
      const mergedLitersMl = has("litersMl")
        ? (input.litersMl ?? existing.litersMl)
        : existing.litersMl;
      const mergedPricePerLiterPaisa = has("pricePerLiterPaisa")
        ? (input.pricePerLiterPaisa ?? existing.pricePerLiterPaisa)
        : existing.pricePerLiterPaisa;
      totalCostPaisaPatch = deriveTotalCostPaisa(mergedLitersMl, mergedPricePerLiterPaisa);
    }

    const data: Prisma.FuelLogUpdateInput = {
      ...(has("tripId") && {
        trip: input.tripId ? { connect: { id: input.tripId } } : { disconnect: true },
      }),
      ...(has("date") && input.date !== undefined && { date: input.date }),
      ...(has("litersMl") && input.litersMl !== undefined && { litersMl: input.litersMl }),
      ...(has("pricePerLiterPaisa") &&
        input.pricePerLiterPaisa !== undefined && {
          pricePerLiterPaisa: input.pricePerLiterPaisa,
        }),
      ...(totalCostPaisaPatch !== undefined && { totalCostPaisa: totalCostPaisaPatch }),
      ...(has("odometerReadingKm") && { odometerReadingKm: input.odometerReadingKm ?? null }),
      ...(has("station") && { station: input.station ?? null }),
      ...(has("receiptNumber") && { receiptNumber: input.receiptNumber ?? null }),
      ...(has("notes") && { notes: input.notes ?? null }),
    };

    try {
      return await this.prisma.fuelLog.update({
        where: { id },
        data,
        include: DETAIL_INCLUDE,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        // Either the FuelLog row vanished between the findUnique
        // and the update (rare; concurrent DELETE) or — if the
        // PATCH disconnected and reconnected to a now-deleted trip
        // — a related-record check failed. Either way the right
        // response is 404 on the FuelLog itself; the trip case is
        // additionally guarded by assertTripBelongsToVehicle above
        // which would have surfaced a 400 first.
        throw new NotFoundException(`Fuel log ${id} not found`);
      }
      throw mapFuelLogWriteError(error, {
        vehicleId: existing.vehicleId,
        tripId: input.tripId ?? null,
      });
    }
  }

  /**
   * Hard delete a FuelLog. P2025 (delete targets a non-existent
   * row) maps to NotFoundException.
   *
   * FuelLog has no inbound FKs from other aggregates in Phase 1
   * (no other model FK-references it under `onDelete: Restrict`),
   * so the delete path has no 409-delete-blocker branch today. A
   * future Reports v1 aggregate may materialize per-fill summaries;
   * if any of those add an FK to FuelLog under Restrict, this
   * method will gain the same P2003 → ConflictException treatment
   * the Customer / Vehicle deletes have today.
   *
   * Returns void on success; the controller responds 204 No
   * Content.
   */
  async delete(id: string, actor: Actor): Promise<void> {
    // DRIVER may not delete fuel logs (ADR-0034): a driver corrects an entry via
    // PATCH (own-scoped); hard delete of a fuel / odometer record is an
    // operational action reserved for office/admin. 403 (a capability denial),
    // not 404.
    if (actor.role === UserRole.DRIVER) {
      throw new ForbiddenException();
    }
    try {
      await this.prisma.fuelLog.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new NotFoundException(`Fuel log ${id} not found`);
      }
      throw error;
    }
  }

  /**
   * Look up the trip and assert its `vehicleId` matches the
   * supplied one. Throws BadRequestException with both registration
   * numbers named on mismatch, and a generic "trip not found"
   * BadRequest on a missing trip (the Prisma FK would also catch a
   * missing trip on insert as P2003, but surfacing the
   * service-layer check up front makes the error message friendlier
   * — the operator sees "Trip <id> not found" instead of "Trip
   * <id> does not exist" with a stale-FK framing).
   *
   * The trip lookup pulls the vehicle's registrationNumber via a
   * nested select so the error message can name it; if the trip's
   * vehicle is missing somehow (it shouldn't be — Trip.vehicleId
   * is NOT NULL and Vehicle deletes are Restrict-blocked), we fall
   * back to ids.
   */
  private async assertTripBelongsToVehicle(tripId: string, vehicleId: string): Promise<void> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        vehicleId: true,
        vehicle: { select: { registrationNumber: true } },
      },
    });
    if (!trip) {
      throw new BadRequestException(`Trip ${tripId} does not exist.`);
    }
    if (trip.vehicleId !== vehicleId) {
      const thisVehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { registrationNumber: true },
      });
      const tripRegistration = trip.vehicle?.registrationNumber ?? trip.vehicleId;
      const thisRegistration = thisVehicle?.registrationNumber ?? vehicleId;
      throw new BadRequestException(
        `Trip ${tripId} is for vehicle ${tripRegistration}, not vehicle ${thisRegistration}.`,
      );
    }
  }

  /**
   * Assert the trip is the DRIVER's OWN trip (ADR-0034 c4) — the predicate that
   * binds a driver-created (or driver-re-paired) fuel log to their own vehicle,
   * which is the vehicle on their own trip (there is no standing Driver→Vehicle
   * link). Throws NotFoundException (404, existence-hiding) when the trip is
   * missing OR belongs to another driver, so a driver cannot use this write path
   * to probe foreign trip ids — uniform with the trips own-record gate. Used only
   * on the DRIVER write paths (create, and a tripId-touching PATCH).
   */
  private async assertTripOwnedByDriver(tripId: string, ownDriverId: string): Promise<void> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: { driverId: true },
    });
    if (!trip || trip.driverId !== ownDriverId) {
      throw new NotFoundException(`Trip ${tripId} not found`);
    }
  }
}

/**
 * Derive the fuel-log totalCostPaisa from litersMl and
 * pricePerLiterPaisa. Same rounding rule (half-up via `Math.round`)
 * used by both `create` and `update`. See CLAUDE.md §"Money &
 * units" and the glossary's Fuel-log "iter-20" note for the
 * rationale; the `/1000` converts milliliters to liters.
 *
 * Worked example: 12345 mL * 11055 paisa/L / 1000 = 136473.975 →
 * `Math.round` → 136474 paisa = NPR 1364.74. Half-up resolves
 * `.975` upward; truncation (the wrong rule) would produce 136473.
 * The iter-19 seed pre-computed by truncated integer arithmetic
 * (12345 * 11050 / 1000 = 136412); the iter-20 derivation is the
 * new authoritative value and the seed is left untouched in the
 * read-path tests because those rows are inserted directly via
 * Prisma rather than through this service.
 *
 * Half-up rounding (rather than banker's, which would round 0.5
 * toward even) matches the operator's mental model for cash
 * receipts in Nepal and the printed pump-receipts they audit
 * against. A future iter that introduces a per-station price-list
 * with declared rounding policy can revisit this; for Phase 1 the
 * half-up rule is the right operational choice.
 */
export function deriveTotalCostPaisa(litersMl: number, pricePerLiterPaisa: number): number {
  return Math.round((litersMl * pricePerLiterPaisa) / 1000);
}

/**
 * Translate a Prisma write error into a domain-level exception. The
 * iter-20 kickoff §"FK validation mapping" calls for P2003 on
 * `vehicleId` or `tripId` to surface as HTTP 400 with the offending
 * id named verbatim in the message; the (service-side) controller
 * test asserts the format. Unknown FK names fall back to a generic
 * 400 that names the vehicleId (the more common picker error).
 *
 * Errors that aren't recognized propagate unchanged so NestJS's
 * default exception filter can map them to 500.
 */
function mapFuelLogWriteError(
  error: unknown,
  context: { vehicleId: string; tripId: string | null; createdById?: string },
): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
    const meta = error.meta as { field_name?: string; constraint?: string } | undefined;
    const fieldName = String(meta?.field_name ?? meta?.constraint ?? "").toLowerCase();
    if (fieldName.includes("trip")) {
      return new BadRequestException(`Trip ${context.tripId ?? "?"} does not exist.`);
    }
    if (fieldName.includes("createdby") && context.createdById) {
      return new BadRequestException(
        `Authenticated user "${context.createdById}" no longer exists; sign in again.`,
      );
    }
    if (fieldName.includes("vehicle")) {
      return new BadRequestException(`Vehicle ${context.vehicleId} does not exist.`);
    }
    // Unknown FK name — the controller-side common case is a stale
    // vehicleId on the picker, so we name vehicleId as the
    // generic fallback. The web action layer parses the message to
    // route to the right field on the form.
    return new BadRequestException(`Vehicle ${context.vehicleId} does not exist.`);
  }
  return error;
}
