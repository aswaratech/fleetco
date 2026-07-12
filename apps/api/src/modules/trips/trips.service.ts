import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { MeterType, Prisma, UserRole, type Trip, type TripStatus } from "@prisma/client";

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

// DriverScopeService is injected (value import, same eslint override). It is the
// auth module's own-record resolver; `Actor` is the {userId, role} principal the
// controller threads in so the service can scope a DRIVER to their own trips
// (ADR-0034 c4). A non-DRIVER actor resolves to null = no restriction.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DriverScopeService, type Actor } from "../auth/driver-scope.service";

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
  // Dispatch order (ADR-0047 W4). The list surface (W6 dispatch board) shows
  // material + endpoints + acceptance/progress, so the slim projection carries
  // the order scalars + the two Site labels + the milestone timestamps. The
  // consignee fields are Tier-2 PII, disclosed only over the wire to an
  // authorized (trips:*) caller — never logged (pino redact) — the same
  // posture as the driver.fullName already in this projection.
  materialType: true,
  materialNote: true,
  pickupSiteId: true,
  dropoffSiteId: true,
  consigneeName: true,
  consigneePhone: true,
  expectedLoadCount: true,
  specialInstructions: true,
  docketNumber: true,
  offeredAt: true,
  acceptedAt: true,
  arrivedPickupAt: true,
  loadedAt: true,
  arrivedDropoffAt: true,
  deliveredAt: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  vehicle: {
    select: {
      id: true,
      registrationNumber: true,
      // meterType (ADR-0036 B2): the driver app branches its trip start/stop
      // capture on the vehicle's meter (km vs engine-hours vs both). Additive
      // to the slim list projection — the web list ignores the extra field.
      meterType: true,
    },
  },
  driver: {
    select: {
      id: true,
      fullName: true,
    },
  },
  // Pickup / drop-off Site labels (ADR-0047 c4) — just { id, name } so the
  // list can render "Kalimati Crusher → Pokhara Site" without a second fetch.
  // Nullable: a pre-dispatch (PLANNED) trip has neither. The detail endpoint
  // projects the same { id, name }; the map fetches full Site coordinates via
  // the Sites API (W5/W6) rather than fattening every trip payload with them.
  pickupSite: {
    select: {
      id: true,
      name: true,
    },
  },
  dropoffSite: {
    select: {
      id: true,
      name: true,
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
//
// The Trip's own scalar columns (including all the ADR-0047 order fields
// and milestone timestamps) come back automatically with an `include`, so
// only the two Site relations need adding. They are projected to
// { id, name } (ADR-0047 W4) — NOT the full Site — for two reasons: the
// detail view needs only the label here (the map fetches full Site
// coordinates via the Sites API, W5/W6), and keeping the nested Site free
// of its Tier-2 contactName/contactPhone means TripDetail (also returned by
// the agent's get_trip) grows no new nested-PII surface. Nullable: a
// pre-dispatch trip has neither pickup nor drop-off.
const DETAIL_INCLUDE = {
  vehicle: true,
  driver: true,
  pickupSite: { select: { id: true, name: true } },
  dropoffSite: { select: { id: true, name: true } },
} satisfies Prisma.TripInclude;

export type TripDetail = Prisma.TripGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: TripListItem[];
  total: number;
}

// A vehicle is hour-metered — it captures engine-hours — when its meterType
// is ENGINE_HOURS or BOTH; an ODOMETER_KM vehicle never has its engine-hours
// columns touched (ADR-0036 commitment 1). Used by the COMPLETED-transition
// bump to gate the engine-hours advance on the vehicle's meter classification.
function meterIncludesHours(meterType: MeterType): boolean {
  return meterType === MeterType.ENGINE_HOURS || meterType === MeterType.BOTH;
}

@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly driverScope: DriverScopeService,
  ) {}

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
  async list(
    {
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
    },
    actor: Actor,
  ): Promise<ListResult> {
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
    // DRIVER own-record scope (ADR-0034 c4): resolve the acting driver's own
    // Driver.id (null for ADMIN/OFFICE_STAFF; throws 403 for an unlinked driver).
    const ownDriverId = await this.driverScope.resolveOwnDriverId(actor);

    const where: Prisma.TripWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(vehicleId ? { vehicleId } : {}),
      ...(driverId ? { driverId } : {}),
      // A DRIVER sees ONLY their own trips. This spread is LAST so it overrides
      // any client-supplied driverId — `?driverId=<someone-else>` cannot widen
      // the view. For a non-DRIVER, ownDriverId is null → no restriction added.
      ...(ownDriverId !== null ? { driverId: ownDriverId } : {}),
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
  async findById(id: string, actor: Actor): Promise<TripDetail | null> {
    const ownDriverId = await this.driverScope.resolveOwnDriverId(actor);
    const trip = await this.prisma.trip.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
    if (!trip) {
      return null;
    }
    // DRIVER own-record gate (ADR-0034 c4): a driver may read ONLY their own
    // trip. Return null for a foreign trip so the controller renders 404 —
    // existence of other drivers' trips is not disclosed (no 403-vs-404 oracle).
    if (ownDriverId !== null && trip.driverId !== ownDriverId) {
      return null;
    }
    return trip;
  }

  /**
   * Plain Trip lookup without the eager relations. Consumers: the
   * PATCH write path (which needs the existing row but not the nested
   * objects), the agent's update_trip pre-image capture (ADR-0043
   * c4b — the raw row is the faithful undo source), and tests that
   * assert the raw row shape. The service surface is small enough
   * that exposing both shapes is cheaper than an internal-only flag
   * on findById.
   */
  async findByIdRaw(id: string): Promise<Trip | null> {
    return this.prisma.trip.findUnique({ where: { id } });
  }

  /**
   * Assert that any pickup / drop-off Site ids being SET on a dispatch exist,
   * BEFORE the write (ADR-0047 W4), so a stale endpoint surfaces as a
   * deterministic 400 naming the exact field ("Pickup site … does not
   * exist.") rather than leaning on a Prisma error code. This is necessary
   * because the two write paths raise DIFFERENT codes for a missing Site: the
   * create path (scalar FK) raises P2003, but the update path (nested
   * `connect`) raises P2025 — which is ambiguous with "trip row vanished" and
   * therefore cannot be attributed to the Site reliably. A single shared
   * pre-check names the endpoint the same way on both paths. Only non-null ids
   * are checked (null = disconnect / clear); the one findMany runs only when at
   * least one Site is being set (a PLANNED create / a non-order PATCH does no
   * extra query). The P2003 arm in create() remains as TOCTOU-race defense.
   */
  private async assertSitesExist(
    pickupSiteId: string | null | undefined,
    dropoffSiteId: string | null | undefined,
  ): Promise<void> {
    const wantPickup = typeof pickupSiteId === "string" && pickupSiteId.length > 0;
    const wantDropoff = typeof dropoffSiteId === "string" && dropoffSiteId.length > 0;
    if (!wantPickup && !wantDropoff) return;

    const ids: string[] = [];
    if (wantPickup) ids.push(pickupSiteId as string);
    if (wantDropoff) ids.push(dropoffSiteId as string);

    const found = await this.prisma.site.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((s) => s.id));

    if (wantPickup && !foundIds.has(pickupSiteId as string)) {
      throw new BadRequestException(`Pickup site "${pickupSiteId as string}" does not exist.`);
    }
    if (wantDropoff && !foundIds.has(dropoffSiteId as string)) {
      throw new BadRequestException(`Drop-off site "${dropoffSiteId as string}" does not exist.`);
    }
  }

  /**
   * Create a Trip. `createdById` is supplied by the controller from
   * the authenticated session, not by the client. CreateTripSchema's
   * `.strict()` keeps `createdById` (and any other unknown key) off
   * the wire; the service trusts that and uses only fields from
   * `CreateTripInput`.
   *
   * Cross-field rules: the schema's `.superRefine` runs the meter-AGNOSTIC
   * subset (timing presence + end-≥-start) on the body. The meter-AWARE
   * required-reading rule (ADR-0036 c7 — km for ODOMETER_KM, hours for
   * ENGINE_HOURS, both for BOTH) needs the vehicle's meterType, which the
   * schema cannot see, so we re-run `validateTripCrossFields` here with the
   * meterType looked up from the vehicle — but only for the two statuses that
   * carry readings (IN_PROGRESS / COMPLETED), so a PLANNED create (the common
   * case) skips the extra read. A missing vehicle leaves meterType undefined
   * (no required-reading check); the trip.create below then raises the FK
   * P2003 → "Vehicle does not exist." that names the real problem.
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
  async create(input: CreateTripInput, createdById: string, actor: Actor): Promise<TripDetail> {
    // DRIVER may not create trips (ADR-0034): the office assigns a driver +
    // vehicle to a trip; a driver only transitions status via PATCH. 403 (a
    // capability denial), not 404.
    if (actor.role === UserRole.DRIVER) {
      throw new ForbiddenException();
    }

    // Cross-field re-validation. The service is the authority for direct
    // callers (the agent tools, tests) that bypass the schema's superRefine,
    // AND for the meter-aware rule the schema cannot run. We ALWAYS re-run
    // validateTripCrossFields here — it covers the OFFERED order-required rule
    // and the monotonic-milestone rule (ADR-0047 W4) plus, for IN_PROGRESS/
    // COMPLETED, the meter-aware required readings (ADR-0036 c7) — looking up
    // the vehicle's meterType only when a reading-bearing status needs it. A
    // missing vehicle leaves meterType undefined (no required-reading check);
    // the trip.create below then raises the FK P2003 → "Vehicle does not
    // exist." that names the real problem.
    let vehicleMeterType: MeterType | undefined;
    if (input.status === "IN_PROGRESS" || input.status === "COMPLETED") {
      const vehicleMeter = await this.prisma.vehicle.findUnique({
        where: { id: input.vehicleId },
        select: { meterType: true },
      });
      vehicleMeterType = vehicleMeter?.meterType;
    }
    const crossFieldErrors = validateTripCrossFields(input, vehicleMeterType);
    if (crossFieldErrors.length > 0) {
      throw new BadRequestException(crossFieldErrors.join(" "));
    }

    // Name a stale pickup/drop-off Site with a deterministic 400 before the
    // write (ADR-0047 W4). Same pre-check the PATCH path uses.
    await this.assertSitesExist(input.pickupSiteId, input.dropoffSiteId);

    const data: Prisma.TripUncheckedCreateInput = {
      vehicleId: input.vehicleId,
      driverId: input.driverId,
      status: input.status,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      startOdometerKm: input.startOdometerKm ?? null,
      endOdometerKm: input.endOdometerKm ?? null,
      // Engine-hours readings (ADR-0036) — pass-through, null when absent
      // (a km-only vehicle's trip captures no hours).
      startEngineHours: input.startEngineHours ?? null,
      endEngineHours: input.endEngineHours ?? null,
      notes: input.notes ?? null,
      // Dispatch order + milestones (ADR-0047 W4) — pass-through, null when
      // absent (a PLANNED create carries none). pickupSiteId / dropoffSiteId
      // are scalar FKs on the Unchecked create input; a stale id surfaces as
      // the P2003 arm below.
      materialType: input.materialType ?? null,
      materialNote: input.materialNote ?? null,
      pickupSiteId: input.pickupSiteId ?? null,
      dropoffSiteId: input.dropoffSiteId ?? null,
      consigneeName: input.consigneeName ?? null,
      consigneePhone: input.consigneePhone ?? null,
      expectedLoadCount: input.expectedLoadCount ?? null,
      specialInstructions: input.specialInstructions ?? null,
      docketNumber: input.docketNumber ?? null,
      offeredAt: input.offeredAt ?? null,
      acceptedAt: input.acceptedAt ?? null,
      arrivedPickupAt: input.arrivedPickupAt ?? null,
      loadedAt: input.loadedAt ?? null,
      arrivedDropoffAt: input.arrivedDropoffAt ?? null,
      deliveredAt: input.deliveredAt ?? null,
      createdById,
    };

    // Server-stamp the transition timestamps when a trip is created directly
    // INTO a dispatch state and the client did not supply one (ADR-0047 c4/c8:
    // the office/driver taps an action; the server records when it happened).
    // The common path is create-PLANNED-then-PATCH-to-OFFERED, but the W6
    // dispatch form may create straight into OFFERED — so stamp here too,
    // keeping create and update consistent. An explicit client value (e.g. a
    // back-dated offeredAt) is respected.
    const now = new Date();
    if (data.status === "OFFERED" && data.offeredAt == null) {
      data.offeredAt = now;
    }
    if (data.status === "ACCEPTED" && data.acceptedAt == null) {
      data.acceptedAt = now;
    }

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
        // Dispatch order FKs (ADR-0047 W4). assertSitesExist above already
        // named a stale Site with a 400; these arms are the TOCTOU-race defense
        // (a Site deleted between that pre-check and this scalar insert → P2003).
        // The constraint names (Trip_pickupSiteId_fkey / Trip_dropoffSiteId_fkey)
        // carry the disjoint "pickup" / "dropoff" substrings, so the race is
        // still attributed to the right endpoint rather than the generic message.
        if (fieldName.toLowerCase().includes("pickup")) {
          throw new BadRequestException(
            `Pickup site "${input.pickupSiteId ?? ""}" does not exist.`,
          );
        }
        if (fieldName.toLowerCase().includes("dropoff")) {
          throw new BadRequestException(
            `Drop-off site "${input.dropoffSiteId ?? ""}" does not exist.`,
          );
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
  async update(id: string, input: UpdateTripInput, actor: Actor): Promise<TripDetail> {
    const existing = await this.prisma.trip.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Trip "${id}" not found.`);
    }

    // DRIVER own-record gate (ADR-0034 c4): a driver may mutate ONLY their own
    // trip. Resolved here — before the merged-shape build, the transition guard,
    // and the $transaction + odometer bump below — so an owned start/stop runs
    // the existing rules unchanged, and a foreign trip is rejected as 404
    // (existence-hiding) before any write. Reuses the row fetched above.
    const ownDriverId = await this.driverScope.resolveOwnDriverId(actor);
    if (ownDriverId !== null && existing.driverId !== ownDriverId) {
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
      startEngineHours: has("startEngineHours")
        ? (input.startEngineHours ?? null)
        : existing.startEngineHours,
      endEngineHours: has("endEngineHours")
        ? (input.endEngineHours ?? null)
        : existing.endEngineHours,
      // Dispatch fields the cross-field rules read (ADR-0047 W4): the OFFERED
      // order-required rule needs material + pickup + drop-off, and the
      // monotonic-milestone rule needs the six timestamps — all against the
      // MERGED shape, so a PATCH that flips status to OFFERED without re-sending
      // the order is validated against what the row would look like after the
      // write. The other order scalars (consignee, docket, …) are pass-through
      // only and stay out of `merged`.
      materialType: has("materialType") ? (input.materialType ?? null) : existing.materialType,
      pickupSiteId: has("pickupSiteId") ? (input.pickupSiteId ?? null) : existing.pickupSiteId,
      dropoffSiteId: has("dropoffSiteId") ? (input.dropoffSiteId ?? null) : existing.dropoffSiteId,
      offeredAt: has("offeredAt") ? (input.offeredAt ?? null) : existing.offeredAt,
      acceptedAt: has("acceptedAt") ? (input.acceptedAt ?? null) : existing.acceptedAt,
      arrivedPickupAt: has("arrivedPickupAt")
        ? (input.arrivedPickupAt ?? null)
        : existing.arrivedPickupAt,
      loadedAt: has("loadedAt") ? (input.loadedAt ?? null) : existing.loadedAt,
      arrivedDropoffAt: has("arrivedDropoffAt")
        ? (input.arrivedDropoffAt ?? null)
        : existing.arrivedDropoffAt,
      deliveredAt: has("deliveredAt") ? (input.deliveredAt ?? null) : existing.deliveredAt,
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

    // Cross-field validation against the merged shape. The meter-aware
    // required-reading rule (ADR-0036 c7) needs the vehicle's meterType; we
    // look it up for the EFFECTIVE vehicle (a PATCH may reassign vehicleId)
    // only when the merged status carries readings. A missing vehicle leaves
    // meterType undefined (no required-reading check); the FK P2003 below
    // surfaces the real "Vehicle does not exist." on the write.
    let meterType: MeterType | undefined;
    if (merged.status === "IN_PROGRESS" || merged.status === "COMPLETED") {
      const effectiveVehicleId =
        has("vehicleId") && input.vehicleId !== undefined ? input.vehicleId : existing.vehicleId;
      const vehicleMeter = await this.prisma.vehicle.findUnique({
        where: { id: effectiveVehicleId },
        select: { meterType: true },
      });
      meterType = vehicleMeter?.meterType;
    }
    const crossFieldErrors = validateTripCrossFields(merged, meterType);
    if (crossFieldErrors.length > 0) {
      throw new BadRequestException(crossFieldErrors.join(" "));
    }

    // Name a stale pickup/drop-off Site with a deterministic 400 before the
    // write (ADR-0047 W4) — only for the Site FKs this PATCH is actually
    // SETTING (a non-null connect). An untouched or cleared (null) Site is
    // skipped, so a status-only or notes-only PATCH does no extra query.
    await this.assertSitesExist(
      has("pickupSiteId") ? input.pickupSiteId : undefined,
      has("dropoffSiteId") ? input.dropoffSiteId : undefined,
    );

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
      ...(has("startEngineHours") && { startEngineHours: input.startEngineHours ?? null }),
      ...(has("endEngineHours") && { endEngineHours: input.endEngineHours ?? null }),
      ...(has("notes") && { notes: input.notes ?? null }),
      // Dispatch order (ADR-0047 W4). Scalar columns are set directly; the two
      // Site FKs go through the relation — connect a new id, or disconnect on an
      // explicit null (the reassign-back / clear path) — mirroring how
      // vehicleId/driverId reassign above.
      ...(has("materialType") && { materialType: input.materialType ?? null }),
      ...(has("materialNote") && { materialNote: input.materialNote ?? null }),
      ...(has("pickupSiteId") && {
        pickupSite: input.pickupSiteId
          ? { connect: { id: input.pickupSiteId } }
          : { disconnect: true },
      }),
      ...(has("dropoffSiteId") && {
        dropoffSite: input.dropoffSiteId
          ? { connect: { id: input.dropoffSiteId } }
          : { disconnect: true },
      }),
      ...(has("consigneeName") && { consigneeName: input.consigneeName ?? null }),
      ...(has("consigneePhone") && { consigneePhone: input.consigneePhone ?? null }),
      ...(has("expectedLoadCount") && { expectedLoadCount: input.expectedLoadCount ?? null }),
      ...(has("specialInstructions") && { specialInstructions: input.specialInstructions ?? null }),
      ...(has("docketNumber") && { docketNumber: input.docketNumber ?? null }),
      // Milestone timestamps (ADR-0047 W4). offeredAt/acceptedAt may be
      // overwritten by the server stamp below when this PATCH is the → OFFERED
      // / → ACCEPTED transition and the client did not send its own value.
      ...(has("offeredAt") && { offeredAt: input.offeredAt ?? null }),
      ...(has("acceptedAt") && { acceptedAt: input.acceptedAt ?? null }),
      ...(has("arrivedPickupAt") && { arrivedPickupAt: input.arrivedPickupAt ?? null }),
      ...(has("loadedAt") && { loadedAt: input.loadedAt ?? null }),
      ...(has("arrivedDropoffAt") && { arrivedDropoffAt: input.arrivedDropoffAt ?? null }),
      ...(has("deliveredAt") && { deliveredAt: input.deliveredAt ?? null }),
    };

    // Server-stamp the transition timestamps (ADR-0047 c4/c8). When this PATCH
    // moves the trip INTO OFFERED (the admin dispatch) or ACCEPTED (the
    // driver's Accept tap) and the client did not send its own timestamp, the
    // service records when it happened. This is why the OFFERED order-required
    // rule does NOT require offeredAt (the service provides it) and why the
    // driver app can Accept by PATCHing status alone. An explicit client value
    // is respected (it was already written into `data` above, so we only stamp
    // when the key is absent).
    const transitionedToOffered =
      has("status") && input.status === "OFFERED" && existing.status !== "OFFERED";
    const transitionedToAccepted =
      has("status") && input.status === "ACCEPTED" && existing.status !== "ACCEPTED";
    if (transitionedToOffered && !has("offeredAt")) {
      data.offeredAt = new Date();
    }
    if (transitionedToAccepted && !has("acceptedAt")) {
      data.acceptedAt = new Date();
    }

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
    // ADR-0036 extends this beyond the odometer: the SAME transaction now
    // advances up to two meters — odometer (km) always, engine-hours when the
    // vehicle is hour-metered (meterType ENGINE_HOURS/BOTH) — each under the
    // identical monotonic "once forward" (`>`) rule. We enter the bump branch
    // when EITHER end reading is present (a pure ENGINE_HOURS trip carries
    // hours but no odometer), then advance only the meters that move forward.
    const transitionedToCompleted =
      has("status") && input.status === "COMPLETED" && existing.status !== "COMPLETED";
    const bumpEndOdo = transitionedToCompleted && merged.endOdometerKm !== null;
    const bumpEndHours = transitionedToCompleted && merged.endEngineHours !== null;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updatedTrip = await tx.trip.update({
          where: { id },
          data,
          include: DETAIL_INCLUDE,
        });

        if (bumpEndOdo || bumpEndHours) {
          const vehicle = await tx.vehicle.findUniqueOrThrow({
            where: { id: updatedTrip.vehicleId },
            select: { odometerCurrentKm: true, meterType: true, engineHoursCurrent: true },
          });

          // Accumulate only the meter advances that actually move forward,
          // then issue at most one vehicle UPDATE. The eager-included Vehicle
          // on the returned trip is refreshed with the same patch so callers
          // (controllers, tests) observe the bumped value(s) without a
          // follow-up read — cheaper than a second findUnique.
          const vehiclePatch: { odometerCurrentKm?: number; engineHoursCurrent?: number } = {};

          // Odometer — unchanged behavior: advance only when the trip's end
          // odometer is strictly greater than the vehicle's current km. The
          // `>` (not `>=`) avoids a no-op write and blocks a backdated
          // correction trip from moving the odometer backwards.
          if (bumpEndOdo && (merged.endOdometerKm as number) > vehicle.odometerCurrentKm) {
            vehiclePatch.odometerCurrentKm = merged.endOdometerKm as number;
          }

          // Engine-hours (ADR-0036 c5) — only for hour-metered vehicles
          // (ENGINE_HOURS / BOTH; an ODOMETER_KM vehicle never has its hours
          // touched), and only when the reading moves forward. A null current
          // (an hour-metered asset whose SMR was never keyed in) is "behind
          // any reading", so the first completed trip seeds engineHoursCurrent.
          if (
            bumpEndHours &&
            meterIncludesHours(vehicle.meterType) &&
            (vehicle.engineHoursCurrent === null ||
              (merged.endEngineHours as number) > vehicle.engineHoursCurrent)
          ) {
            vehiclePatch.engineHoursCurrent = merged.endEngineHours as number;
          }

          if (Object.keys(vehiclePatch).length > 0) {
            await tx.vehicle.update({
              where: { id: updatedTrip.vehicleId },
              data: vehiclePatch,
            });
            updatedTrip.vehicle = { ...updatedTrip.vehicle, ...vehiclePatch };
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
        // NB: a stale pickup/drop-off Site is caught by assertSitesExist BEFORE
        // this write. On PATCH a Site is connected via a nested `connect`, which
        // raises P2025 (ambiguous with "trip row vanished"), NOT P2003 — so it
        // cannot be named reliably in this arm; the pre-check names the endpoint.
        throw new BadRequestException(
          `One of vehicleId or driverId references a record that does not exist.`,
        );
      }
      throw error;
    }
  }

  /**
   * Hard delete a Trip. Maps Prisma errors per
   * docs/runbook/api-error-mapping.md:
   *   - P2025 (delete targets a non-existent row) -> NotFoundException
   *     (HTTP 404).
   *   - P2003 (another row still references this Trip via an
   *     onDelete: Restrict FK) -> ConflictException (HTTP 409).
   *
   * The P2003 arm lands in the GPS-telematics slice (ADR-0029 T2,
   * commitment 7): GpsPing.tripId is an onDelete: Restrict FK, which
   * makes Trip a referenced aggregate and makes this mapping due. It
   * also corrects a latent gap the iter-8 docstring missed — FuelLog
   * .tripId and ExpenseLog.tripId (both onDelete: Restrict, shipped in
   * Phase 1) already referenced Trip, so deleting a Trip that had any
   * fuel/expense log was raising P2003 that propagated as an HTTP 500
   * until now.
   *
   * The message is the GENERIC "referenced by other records." shape
   * (mirroring CustomersService.delete) rather than VehiclesService's
   * count-of-trips message, because Trip has multiple heterogeneous
   * referencers (FuelLog, ExpenseLog, GpsPing); naming a single count
   * would be misleading and would cost extra queries across three
   * tables. Resolution choice per ADR-0029 acceptance: a P2003 -> 409
   * catch arm, NOT soft delete (which would be a new cross-cutting
   * pattern warranting its own ADR).
   *
   * Returns void on success; the controller responds 204 No Content.
   */
  async delete(id: string, actor: Actor): Promise<void> {
    // DRIVER may not delete trips (ADR-0034): hard delete of a trip is an
    // operational action reserved for office/admin; a driver only starts/stops.
    // 403 (a capability denial), not 404.
    if (actor.role === UserRole.DRIVER) {
      throw new ForbiddenException();
    }
    try {
      await this.prisma.trip.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // P2025 = delete targeted a non-existent row.
        if (error.code === "P2025") {
          throw new NotFoundException(`Trip "${id}" not found.`);
        }
        // P2003 = FK constraint violation on the referencing side: a
        // FuelLog, ExpenseLog, or GpsPing (each onDelete: Restrict on
        // tripId) still points at this Trip. Surface as 409 with the
        // generic referenced-by-other-records message.
        if (error.code === "P2003") {
          throw new ConflictException(`Cannot delete trip: it is referenced by other records.`);
        }
      }
      throw error;
    }
  }

  /**
   * Per-vehicle lifetime stats — aggregates the trip history into four
   * scalars the Vehicle detail page surfaces (count + km from iter 12;
   * engine-hours added by ADR-0036). Called by
   * VehiclesController via `TripsModule`'s export — the aggregation
   * lives here (next to `list` / `findById`) rather than on
   * VehiclesService because the underlying data is Trip rows.
   *
   * Scope decisions (see /docs/glossary.md and the iter-11 odometer
   * auto-update for the policy rationale):
   *   - `completedTripCount` counts COMPLETED trips only. PLANNED and
   *     IN_PROGRESS trips have no settled distance; CANCELLED is voided.
   *   - `totalKmLogged` sums `endOdometerKm − startOdometerKm` across
   *     COMPLETED trips only. Both fields are non-null on COMPLETED
   *     rows (cross-field validation enforces it), so the subtraction
   *     is safe; `?? 0` defends against an empty result set.
   *   - `totalHoursLogged` (ADR-0036) sums `endEngineHours −
   *     startEngineHours` (integer tenths-of-an-hour) across COMPLETED
   *     trips only — the hours rotation of `totalKmLogged`. It is 0 for a
   *     km-only fleet (the hours columns are null, `?? 0` → 0); display
   *     divides by 10. Computed in the same `$transaction` snapshot.
   *   - `mostRecentDriver` is the driver on the trip with the largest
   *     non-null `startedAt` — "who last actually drove this vehicle".
   *     Includes IN_PROGRESS, COMPLETED, and any CANCELLED-after-start.
   *     PLANNED trips have `startedAt = null` and are excluded.
   *
   * The three Prisma queries run inside a single `$transaction([...])`
   * so the three reads see a consistent snapshot (without it, a trip
   * COMPLETED between query 1 and query 2 could appear in the count
   * but not the sum, or vice versa).
   */
  async statsForVehicle(vehicleId: string): Promise<{
    completedTripCount: number;
    totalKmLogged: number;
    totalHoursLogged: number;
    mostRecentDriver: {
      id: string;
      fullName: string;
      tripId: string;
      startedAt: Date;
    } | null;
  }> {
    const [completedTripCount, sumAggregate, mostRecentTrip] = await this.prisma.$transaction([
      this.prisma.trip.count({
        where: { vehicleId, status: "COMPLETED" },
      }),
      this.prisma.trip.aggregate({
        where: { vehicleId, status: "COMPLETED" },
        _sum: {
          endOdometerKm: true,
          startOdometerKm: true,
          endEngineHours: true,
          startEngineHours: true,
        },
      }),
      this.prisma.trip.findFirst({
        where: { vehicleId, startedAt: { not: null } },
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          driver: { select: { id: true, fullName: true } },
        },
      }),
    ]);

    const sumEnd = sumAggregate._sum.endOdometerKm ?? 0;
    const sumStart = sumAggregate._sum.startOdometerKm ?? 0;
    const totalKmLogged = sumEnd - sumStart;
    const sumEndHours = sumAggregate._sum.endEngineHours ?? 0;
    const sumStartHours = sumAggregate._sum.startEngineHours ?? 0;
    const totalHoursLogged = sumEndHours - sumStartHours;

    const mostRecentDriver =
      mostRecentTrip && mostRecentTrip.startedAt
        ? {
            id: mostRecentTrip.driver.id,
            fullName: mostRecentTrip.driver.fullName,
            tripId: mostRecentTrip.id,
            startedAt: mostRecentTrip.startedAt,
          }
        : null;

    return { completedTripCount, totalKmLogged, totalHoursLogged, mostRecentDriver };
  }

  /**
   * Per-driver lifetime stats — the symmetric mirror of
   * `statsForVehicle`. Iter 13 surfaced the same aggregations on the
   * Driver detail page that iter 12 added to the Vehicle detail page,
   * rotated 90° around the Trip aggregate (Drivers join Trips on
   * `driverId` the same way Vehicles do on `vehicleId`); ADR-0036 adds
   * `totalHoursLogged` to both in lockstep (commitment 6).
   *
   * Scope decisions mirror the vehicle variant exactly:
   *   - `completedTripCount` counts COMPLETED trips only. PLANNED and
   *     IN_PROGRESS trips have no settled distance; CANCELLED is voided.
   *   - `totalKmLogged` sums `endOdometerKm − startOdometerKm` across
   *     COMPLETED trips only. Both fields are non-null on COMPLETED
   *     rows (cross-field validation enforces it), so the subtraction
   *     is safe; `?? 0` defends against an empty result set.
   *   - `totalHoursLogged` (ADR-0036) sums `endEngineHours −
   *     startEngineHours` (integer tenths-of-an-hour) across COMPLETED
   *     trips only — the hours rotation of `totalKmLogged`, 0 for a
   *     km-only fleet. Computed in the same `$transaction` snapshot.
   *   - `mostRecentVehicle` is the vehicle on the trip with the largest
   *     non-null `startedAt` — "what was last paired with this driver".
   *     Includes IN_PROGRESS, COMPLETED, and any CANCELLED-after-start.
   *     PLANNED trips have `startedAt = null` and are excluded. The
   *     vehicle's `registrationNumber` is the natural label per the
   *     glossary — it is the canonical short identifier in this domain
   *     (not "make + model").
   *
   * The three Prisma queries run inside a single `$transaction([...])`
   * so the three reads see a consistent snapshot (without it, a trip
   * COMPLETED between query 1 and query 2 could appear in the count
   * but not the sum, or vice versa).
   */
  async statsForDriver(driverId: string): Promise<{
    completedTripCount: number;
    totalKmLogged: number;
    totalHoursLogged: number;
    mostRecentVehicle: {
      id: string;
      registrationNumber: string;
      tripId: string;
      startedAt: Date;
    } | null;
  }> {
    const [completedTripCount, sumAggregate, mostRecentTrip] = await this.prisma.$transaction([
      this.prisma.trip.count({
        where: { driverId, status: "COMPLETED" },
      }),
      this.prisma.trip.aggregate({
        where: { driverId, status: "COMPLETED" },
        _sum: {
          endOdometerKm: true,
          startOdometerKm: true,
          endEngineHours: true,
          startEngineHours: true,
        },
      }),
      this.prisma.trip.findFirst({
        where: { driverId, startedAt: { not: null } },
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          vehicle: { select: { id: true, registrationNumber: true } },
        },
      }),
    ]);

    const sumEnd = sumAggregate._sum.endOdometerKm ?? 0;
    const sumStart = sumAggregate._sum.startOdometerKm ?? 0;
    const totalKmLogged = sumEnd - sumStart;
    const sumEndHours = sumAggregate._sum.endEngineHours ?? 0;
    const sumStartHours = sumAggregate._sum.startEngineHours ?? 0;
    const totalHoursLogged = sumEndHours - sumStartHours;

    const mostRecentVehicle =
      mostRecentTrip && mostRecentTrip.startedAt
        ? {
            id: mostRecentTrip.vehicle.id,
            registrationNumber: mostRecentTrip.vehicle.registrationNumber,
            tripId: mostRecentTrip.id,
            startedAt: mostRecentTrip.startedAt,
          }
        : null;

    return { completedTripCount, totalKmLogged, totalHoursLogged, mostRecentVehicle };
  }
}
