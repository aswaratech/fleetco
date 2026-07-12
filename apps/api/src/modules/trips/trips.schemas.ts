import { z } from "zod";

// Zod schemas for the Trips slice — iter 8 shipped the read path
// (ListTripsQuerySchema); iter 9 adds the write path (CreateTripSchema,
// UpdateTripSchema), mirroring the Drivers iter-6/iter-7 staging.
//
// Mirrors apps/api/src/modules/drivers/drivers.schemas.ts in shape and
// convention: enum lists duplicated from Prisma enums (so this file
// does not pull the Prisma runtime), `.strict()` on every object so a
// typo'd query key surfaces as HTTP 400, comma-separated multi-value
// enum filters via `csvEnum`, and an explicit pagination ceiling
// mirrored from the service-side MAX_TAKE constant.

// TripStatus enum — must mirror TripStatus in prisma/schema.prisma.
// Order matches the Prisma enum so an audit grep finds both lists side
// by side; the order has no runtime significance.
//
// ADR-0047 c1 added OFFERED and ACCEPTED (the dispatch → acceptance states)
// between PLANNED and IN_PROGRESS. W2 staged the two values into this array
// (so the wire schemas accept them) and the Prisma enum; W4 (this ticket)
// wires the dispatch TRANSITION SEMANTICS (PLANNED → OFFERED → ACCEPTED →
// IN_PROGRESS, with CANCELLED reachable from any non-terminal state and
// OFFERED → PLANNED the reassign-back path) — see TRIP_STATUS_TRANSITIONS
// below.
const TRIP_STATUSES = [
  "PLANNED",
  "OFFERED",
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

// MaterialType enum — must mirror MaterialType in prisma/schema.prisma
// (ADR-0047 c5). Duplicated as a local string tuple for the same reason
// TRIP_STATUSES is: this file must not pull the Prisma runtime. Order
// matches the Prisma enum so an audit grep finds both lists side by side.
// `OTHER` is the escape hatch paired with the free-text materialNote.
const MATERIAL_TYPES = [
  "SAND",
  "AGGREGATE",
  "GRAVEL",
  "STONE",
  "BOULDER",
  "SOIL",
  "BRICKS",
  "OTHER",
] as const;

// GET /api/v1/trips query parameters (iter 8 — read path).
// Filter / sort / pagination contract mirrors the Drivers and Vehicles
// list endpoints; the web client's URL-searchParams convention is
// shared across all three surfaces so the same paginator /
// sortable-header / filter-toolbar idioms transfer without surprises.
//
// Wire conventions:
//   - `status` accepts either a single value (`?status=PLANNED`) or a
//     comma-separated list (`?status=PLANNED,IN_PROGRESS`). Normalizes
//     to a deduplicated array; the service builds a Prisma `in:`
//     filter from it. An empty string after splitting is treated as
//     "no filter".
//   - `vehicleId` and `driverId` accept a single string. We do NOT
//     parse them as cuids here: the kickoff explicitly allows "accept
//     any string and let the service no-op" — an unknown id will
//     simply produce an empty result set, which is the right shape
//     for a "trips for this vehicle" UI that hits a deleted-vehicle
//     bookmark. Tightening to a cuid format would require an ADR per
//     CLAUDE.md.
//   - `sortBy` is restricted to a whitelist of sortable columns
//     (startedAt / endedAt / createdAt). Allowing arbitrary columns
//     would invite expensive sorts and accidental information
//     disclosure (`sortBy=notes` would expose ordering information
//     about free-form operator text).
//   - `sortDir` defaults to `desc` because "most recent first" is the
//     common case for both `createdAt` and `startedAt`. Consistency
//     with the Drivers / Vehicles surface wins over per-column
//     defaults.
//   - `skip` defaults to 0; `take` defaults to 20. The schema's `take`
//     ceiling mirrors the service's MAX_TAKE so an over-large `take`
//     surfaces as HTTP 400 with a clear message rather than being
//     silently clamped.
const SORTABLE_COLUMNS = ["startedAt", "endedAt", "createdAt"] as const;
export type TripSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type TripSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from trips.service.ts on purpose: the
// service is the runtime authority (the schema can only validate what
// the client sent; it cannot speak for the database). Both constants
// must move together when one changes; the JSDoc on
// trips.service.ts's LIST_TAKE_MAX flags the same coupling.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a
// validated, deduplicated array of enum members. Reused by `status`.
// An empty result (e.g., `?status=`) is mapped to `undefined` so the
// service can omit the filter rather than asking Prisma for
// `where status in ()` — which would match zero rows.
//
// Identical in shape to the Drivers and Vehicles versions; promoting
// to a shared helper is deferred until the fourth aggregate
// (Customers, later in Phase 1) needs it — the duplication budget
// threshold documented for service-level helpers.
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  const member = z.enum(values);
  return z
    .string()
    .optional()
    .transform((raw, ctx): T[number][] | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return undefined;
      const seen = new Set<T[number]>();
      for (const part of parts) {
        const parsed = member.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({
            code: "custom",
            message: `Must be one of: ${values.join(", ")}.`,
          });
          return z.NEVER;
        }
        seen.add(parsed.data);
      }
      return Array.from(seen);
    });
}

// Coerce a string-typed query param to a non-negative integer with
// bounds checking. Same shape as the Drivers schema helper; out-of-range
// values return 400 with a clear message rather than being silently
// clamped — a deliberate `take=10000` clamped to 200 would surprise an
// API consumer who expected to receive what they asked for.
function intParam(min: number, max: number, fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be an integer.` });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${min} or greater.` });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({
          code: "custom",
          message: `${fieldLabel} must be ${max} or less.`,
        });
        return z.NEVER;
      }
      return n;
    });
}

// `vehicleId` / `driverId` filters: accept any non-empty string. The
// service builds a Prisma `where vehicleId = ?` filter; a non-existent
// id naturally returns the empty result set, which is the right UX
// for a "trips for this vehicle" URL that survives a deleted vehicle.
// An empty string (e.g., from `?vehicleId=`) is normalized to undefined
// so the service omits the filter rather than asking Prisma for
// `where vehicleId = ''`. We accept any non-empty string (no cuid
// format check): the kickoff explicitly allows "accept any string and
// let the service no-op" on unknown ids.
const IdFilter = z
  .string()
  .optional()
  .transform((raw) => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });

export const ListTripsQuerySchema = z
  .object({
    status: csvEnum(TRIP_STATUSES),
    vehicleId: IdFilter,
    driverId: IdFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?statuss=PLANNED`) surfaces as
  // 400 rather than being silently ignored. Matches the Drivers and
  // Vehicles contract.
  .strict();

export type ListTripsQuery = z.infer<typeof ListTripsQuerySchema>;

// ---------------------------------------------------------------------
// Write-path schemas (iter 9) — POST and PATCH bodies.
// ---------------------------------------------------------------------
//
// Both schemas are `.strict()` so an unexpected key (e.g. a client
// trying to set `createdById` directly, or a typo'd field name)
// surfaces as HTTP 400 with a clear message rather than being silently
// dropped. `createdById` is server-derived from the session and must
// never be accepted from the wire — `.strict()` is what enforces that.
//
// Field-level validators mirror what the database can store
// (odometer bounds, notes length) and the wire shape (ISO datetime
// strings for the timing fields). Cross-field rules — "if status is
// IN_PROGRESS then startedAt and startOdometerKm must be set",
// "if status is COMPLETED then all four start/end fields must be set
// and end >= start" — are layered on via `.superRefine`. CANCELLED is
// deliberately unconstrained: a trip planned and then cancelled before
// starting has no startedAt, and the operator should be able to record
// that.

// ISO-8601 datetime string. We accept the broad ISO surface here (with
// or without milliseconds, with or without an offset) because the web
// form will normalize to UTC `Z` form before sending; a stricter regex
// would reject legitimate timestamps from API clients in other tools.
// Prisma coerces strings to Date at write time.
const TripDateTime = z.iso.datetime({ offset: true, local: true });

// Odometer bounds: the bigger end of the range matches the Phase 1
// "no vehicle has clocked more than 10 million kilometers" assumption
// from the Vehicles schema; the lower bound is 0 (negative odometers
// are nonsensical). Storing as integer matches the Prisma schema's
// `Int?` column.
const ODOMETER_MIN = 0;
const ODOMETER_MAX = 9_999_999;

// Notes upper bound mirrors the Driver/Vehicle free-form-text caps —
// the column is unbounded in Postgres but a 1000-character ceiling
// keeps the surface predictable (a 100MB note would 500 the API for
// reasons of memory, not validation). Operators wanting a longer log
// will get an attachments slice in Phase 2.
const NOTES_MAX = 1000;

const OdometerInt = z
  .number()
  .int("Odometer must be an integer.")
  .min(ODOMETER_MIN, `Odometer must be ${ODOMETER_MIN} or greater.`)
  .max(ODOMETER_MAX, `Odometer must be ${ODOMETER_MAX} or less.`);

// Engine-hours bounds (ADR-0036): integer TENTHS OF AN HOUR (deci-hours),
// never a float — the FuelLog.litersMl integer-minor-units precedent. The
// cap (10,000,000 tenths = 1,000,000 hours) mirrors the vehicles schema's
// ENGINE_HOURS_MAX_TENTHS and is well past any real hour-meter; 0 lower
// bound (negative hours are nonsensical). Integer matches Trip's Int? cols.
const ENGINE_HOURS_MIN = 0;
const ENGINE_HOURS_MAX = 10_000_000;

const EngineHoursInt = z
  .number()
  .int("Engine hours must be an integer number of tenths-of-an-hour.")
  .min(ENGINE_HOURS_MIN, `Engine hours must be ${ENGINE_HOURS_MIN} or greater.`)
  .max(ENGINE_HOURS_MAX, `Engine hours must be ${ENGINE_HOURS_MAX} or less.`);

// ── Dispatch-order field validators (ADR-0047 W4) ─────────────────────
// The structured haulage order the trip executes (ADR-0047 c3/c5/c6).
// Defined once here and applied with `.nullable().optional()` in
// CreateTripSchema and `.nullable()` (then `.partial()`) in
// UpdateTripSchema — the same base-validator pattern OdometerInt /
// EngineHoursInt follow, so the two schemas cannot drift on bounds.
// Free-text caps mirror NOTES_MAX's rationale (keep the surface
// predictable; the column itself is unbounded in Postgres).
const MATERIAL_NOTE_MAX = 500;
const CONSIGNEE_NAME_MAX = 200;
const CONSIGNEE_PHONE_MAX = 40;
const SPECIAL_INSTRUCTIONS_MAX = 1000;
const DOCKET_NUMBER_MAX = 100;
// A dispatch is at least one load; the ceiling is generous (one trip is
// still one load per ADR-0047 c1 — this is the operator's expectation hint,
// not a hard multiplicity).
const LOAD_COUNT_MIN = 1;
const LOAD_COUNT_MAX = 100_000;

const MaterialTypeEnum = z.enum(MATERIAL_TYPES);
// pickup/drop-off Site ids: any non-empty string (a cuid in practice; the
// service resolves the FK and maps a stale id to 400, exactly like
// vehicleId/driverId). No cuid-format check here — same rationale as the
// IdFilter above.
const SiteId = z.string().min(1, "Site id must be non-empty.");
const MaterialNote = z
  .string()
  .max(MATERIAL_NOTE_MAX, `materialNote must be at most ${MATERIAL_NOTE_MAX} characters.`);
const ConsigneeName = z
  .string()
  .max(CONSIGNEE_NAME_MAX, `consigneeName must be at most ${CONSIGNEE_NAME_MAX} characters.`);
const ConsigneePhone = z
  .string()
  .max(CONSIGNEE_PHONE_MAX, `consigneePhone must be at most ${CONSIGNEE_PHONE_MAX} characters.`);
const SpecialInstructions = z
  .string()
  .max(
    SPECIAL_INSTRUCTIONS_MAX,
    `specialInstructions must be at most ${SPECIAL_INSTRUCTIONS_MAX} characters.`,
  );
const DocketNumber = z
  .string()
  .max(DOCKET_NUMBER_MAX, `docketNumber must be at most ${DOCKET_NUMBER_MAX} characters.`);
const ExpectedLoadCount = z
  .number()
  .int("expectedLoadCount must be an integer.")
  .min(LOAD_COUNT_MIN, `expectedLoadCount must be ${LOAD_COUNT_MIN} or greater.`)
  .max(LOAD_COUNT_MAX, `expectedLoadCount must be ${LOAD_COUNT_MAX} or less.`);

// Mirror of Prisma's MeterType enum values (ADR-0036). This schema file
// deliberately does not import the Prisma runtime (see the header), so the
// meter classification is expressed as a local string union; the service
// passes `vehicle.meterType`, whose Prisma type is exactly this union, so the
// two stay assignable without a runtime coupling. `undefined` is the
// "meter unknown to this caller" case — see validateTripCrossFields below.
export type TripMeterType = "ODOMETER_KM" | "ENGINE_HOURS" | "BOTH";

// `superRefine` callback shared by the create and update schemas. It
// receives the merged shape (for update: pre-fetched row + patch
// applied; for create: just the body) and enforces the cross-field
// rules from the iter-9 kickoff. Surfaced as a separate function so
// the service can re-invoke it after merging a PATCH against the
// existing row — Zod's `.superRefine` runs on the validated body
// only, but the merged shape is what carries the semantic constraint.
//
// The function takes the trip-shaped fields the rule looks at, not the
// full Zod ctx, so it can be called either inside a Zod schema (which
// builds the ctx) or directly from the service (which throws
// BadRequestException with the same message).
export interface TripCrossFieldShape {
  status: (typeof TRIP_STATUSES)[number];
  startedAt?: string | Date | null | undefined;
  endedAt?: string | Date | null | undefined;
  startOdometerKm?: number | null | undefined;
  endOdometerKm?: number | null | undefined;
  startEngineHours?: number | null | undefined;
  endEngineHours?: number | null | undefined;
  // Dispatch order + milestones (ADR-0047 W4). The order-required-at-OFFERED
  // rule reads materialType/pickupSiteId/dropoffSiteId (presence only — the
  // enum value / FK validity are the schema's / service's job), and the
  // monotonic rule reads the six milestone timestamps. Typed loosely
  // (string) because these checks only look at presence + ordering, never
  // the enum member — this keeps the Prisma `MaterialType` row value
  // assignable without a runtime coupling (same spirit as TripMeterType).
  materialType?: string | null | undefined;
  pickupSiteId?: string | null | undefined;
  dropoffSiteId?: string | null | undefined;
  offeredAt?: string | Date | null | undefined;
  acceptedAt?: string | Date | null | undefined;
  arrivedPickupAt?: string | Date | null | undefined;
  loadedAt?: string | Date | null | undefined;
  arrivedDropoffAt?: string | Date | null | undefined;
  deliveredAt?: string | Date | null | undefined;
}

/**
 * Validate the trip cross-field rules against a merged shape. Returns
 * a list of human-readable error messages; an empty array means valid.
 *
 * Rules (the timing checks are meter-agnostic; the reading-required checks
 * are meter-aware per ADR-0036 c7 — see `meterType` below):
 *   - IN_PROGRESS: startedAt MUST be set; the meter's start reading MUST be set.
 *   - COMPLETED:   startedAt + endedAt MUST be set; the meter's start AND end
 *                  reading MUST be set; endedAt >= startedAt; and end >= start
 *                  for whichever reading pair(s) are present.
 *   - OFFERED (ADR-0047 W4): the order MUST be set — materialType +
 *                  pickupSiteId + dropoffSiteId. No meter reading is
 *                  required at OFFERED/ACCEPTED (capture starts at Start).
 *   - Milestone timestamps (offeredAt, acceptedAt, arrivedPickupAt,
 *     loadedAt, arrivedDropoffAt, deliveredAt): where present, must be
 *     monotonic non-decreasing in that dispatch order — for EVERY status
 *     except CANCELLED.
 *   - PLANNED / CANCELLED: no order/meter constraint (a planned trip may
 *     have startedAt prefilled for scheduling; a cancelled trip may have
 *     been cancelled at any lifecycle stage and so any combination of
 *     fields is legitimate — CANCELLED is exempt from the monotonic rule
 *     too).
 *
 * Meter-aware required readings (ADR-0036 c7). `meterType` says which
 * reading(s) the asset captures:
 *   - ODOMETER_KM  → odometer required, engine-hours not.
 *   - ENGINE_HOURS → engine-hours required, odometer not.
 *   - BOTH         → both required.
 * When `meterType` is `undefined` the caller does not know the vehicle's
 * meter — the CreateTripSchema `.superRefine` path, which sees only the
 * request body and not the Vehicle row. In that case the required-reading
 * check is SKIPPED and the *service* re-runs this with the real meterType
 * (looked up from the vehicle) as the authority. This is why a pure
 * ENGINE_HOURS vehicle can now complete a trip carrying hours and no
 * odometer: B1 required odometer unconditionally here, which is exactly
 * the bug B2 relaxes. The end-≥-start invariants are meter-agnostic and
 * always run for any reading pair that is present — keeping
 * totalKmLogged / totalHoursLogged (Σ end − start) from going negative.
 *
 * The service calls this (with meterType) after merging a PATCH and on
 * create; the schema calls this (via superRefine, without meterType) on
 * the body alone as the client-facing first line.
 */
export function validateTripCrossFields(
  shape: TripCrossFieldShape,
  meterType?: TripMeterType,
): string[] {
  const errors: string[] = [];
  const {
    status,
    startedAt,
    endedAt,
    startOdometerKm,
    endOdometerKm,
    startEngineHours,
    endEngineHours,
    materialType,
    pickupSiteId,
    dropoffSiteId,
    offeredAt,
    acceptedAt,
    arrivedPickupAt,
    loadedAt,
    arrivedDropoffAt,
    deliveredAt,
  } = shape;
  const hasStartedAt = startedAt !== null && startedAt !== undefined;
  const hasEndedAt = endedAt !== null && endedAt !== undefined;
  const hasStartOdo = startOdometerKm !== null && startOdometerKm !== undefined;
  const hasEndOdo = endOdometerKm !== null && endOdometerKm !== undefined;
  const hasStartHours = startEngineHours !== null && startEngineHours !== undefined;
  const hasEndHours = endEngineHours !== null && endEngineHours !== undefined;

  // Which reading(s) the meter requires. When meterType is undefined (the
  // schema-superRefine path), neither is required here — the service is the
  // authority once it knows the vehicle's meter.
  const requireOdometer = meterType === "ODOMETER_KM" || meterType === "BOTH";
  const requireHours = meterType === "ENGINE_HOURS" || meterType === "BOTH";

  if (status === "IN_PROGRESS") {
    if (!hasStartedAt) {
      errors.push("startedAt is required when status is IN_PROGRESS.");
    }
    if (requireOdometer && !hasStartOdo) {
      errors.push("startOdometerKm is required when status is IN_PROGRESS.");
    }
    if (requireHours && !hasStartHours) {
      errors.push("startEngineHours is required when status is IN_PROGRESS.");
    }
  }
  if (status === "COMPLETED") {
    if (!hasStartedAt) errors.push("startedAt is required when status is COMPLETED.");
    if (!hasEndedAt) errors.push("endedAt is required when status is COMPLETED.");
    if (requireOdometer && !hasStartOdo)
      errors.push("startOdometerKm is required when status is COMPLETED.");
    if (requireOdometer && !hasEndOdo)
      errors.push("endOdometerKm is required when status is COMPLETED.");
    if (requireHours && !hasStartHours)
      errors.push("startEngineHours is required when status is COMPLETED.");
    if (requireHours && !hasEndHours)
      errors.push("endEngineHours is required when status is COMPLETED.");
    // end-≥-start invariants — meter-agnostic, checked for whichever pair is
    // present so a BOTH vehicle that carries both readings validates both.
    if (hasStartOdo && hasEndOdo) {
      const start = startOdometerKm as number;
      const end = endOdometerKm as number;
      if (end < start) {
        errors.push("endOdometerKm must be greater than or equal to startOdometerKm.");
      }
    }
    if (hasStartHours && hasEndHours) {
      const start = startEngineHours as number;
      const end = endEngineHours as number;
      if (end < start) {
        errors.push("endEngineHours must be greater than or equal to startEngineHours.");
      }
    }
    if (hasStartedAt && hasEndedAt) {
      const start = new Date(startedAt as string | Date).getTime();
      const end = new Date(endedAt as string | Date).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
        errors.push("endedAt must be greater than or equal to startedAt.");
      }
    }
  }

  // ── Dispatch order + milestones (ADR-0047 W4) ─────────────────────────
  // CANCELLED is unconstrained (a trip may be aborted at any lifecycle
  // stage, so any combination of order fields / timestamps is legitimate) —
  // the same exemption PLANNED/CANCELLED already enjoy for the meter rules.
  if (status !== "CANCELLED") {
    // The order (material + pickup + drop-off) is REQUIRED at → OFFERED: a
    // dispatch cannot go out without knowing what to haul and the two
    // endpoints (ADR-0047 c3). This mirrors how a start reading is required
    // at IN_PROGRESS. `offeredAt` itself is NOT required here — the service
    // stamps it on the transition (ADR-0047 c4 / the service's update()).
    // driver + vehicle are structurally guaranteed (Trip.vehicleId /
    // driverId are NOT NULL), so only the order needs an explicit check.
    if (status === "OFFERED") {
      if (materialType === null || materialType === undefined) {
        errors.push("materialType is required when status is OFFERED.");
      }
      if (pickupSiteId === null || pickupSiteId === undefined) {
        errors.push("pickupSiteId is required when status is OFFERED.");
      }
      if (dropoffSiteId === null || dropoffSiteId === undefined) {
        errors.push("dropoffSiteId is required when status is OFFERED.");
      }
    }

    // Milestone timestamps, where present, must be non-decreasing in the
    // dispatch order offeredAt ≤ acceptedAt ≤ arrivedPickupAt ≤ loadedAt ≤
    // arrivedDropoffAt ≤ deliveredAt — a trip cannot be delivered before it
    // was loaded, loaded before arrival at pickup, etc. (ADR-0047 c1/c3,
    // progress-as-timestamps). Only present values are compared against
    // their nearest present predecessor, so a partial sequence (e.g. only
    // offeredAt + deliveredAt) still validates that pair. A malformed date
    // string is the schema's job (z.iso.datetime), so a non-finite time is
    // skipped rather than double-reported here.
    const milestones: [string, string | Date | null | undefined][] = [
      ["offeredAt", offeredAt],
      ["acceptedAt", acceptedAt],
      ["arrivedPickupAt", arrivedPickupAt],
      ["loadedAt", loadedAt],
      ["arrivedDropoffAt", arrivedDropoffAt],
      ["deliveredAt", deliveredAt],
    ];
    let prevName: string | undefined;
    let prevTime: number | undefined;
    for (const [name, value] of milestones) {
      if (value === null || value === undefined) continue;
      const time = new Date(value).getTime();
      if (!Number.isFinite(time)) continue;
      if (prevTime !== undefined && prevName !== undefined && time < prevTime) {
        errors.push(`${name} must be greater than or equal to ${prevName}.`);
      }
      prevName = name;
      prevTime = time;
    }
  }

  return errors;
}

// POST /api/v1/trips body schema. Required: vehicleId, driverId,
// status. Optional + nullable: timing and odometer fields. The client
// must include `status` explicitly even though `PLANNED` is the
// natural default — making it explicit forces the operator to pick a
// lifecycle stage at create time, which prevents the "I clicked
// Create and now I have a phantom PLANNED trip I didn't mean" foot-gun.
export const CreateTripSchema = z
  .object({
    vehicleId: z.string().min(1, "vehicleId is required."),
    driverId: z.string().min(1, "driverId is required."),
    status: z.enum(TRIP_STATUSES),
    startedAt: TripDateTime.nullable().optional(),
    endedAt: TripDateTime.nullable().optional(),
    startOdometerKm: OdometerInt.nullable().optional(),
    endOdometerKm: OdometerInt.nullable().optional(),
    // Engine-hours readings (ADR-0036) — nullable + optional, captured only
    // for hour-metered vehicles. The meterType-aware "which reading is
    // required" rule (B2) runs in the service, which knows the vehicle's
    // meter; the wire shape accepts the readings when present.
    startEngineHours: EngineHoursInt.nullable().optional(),
    endEngineHours: EngineHoursInt.nullable().optional(),
    notes: z.string().max(NOTES_MAX, `notes must be at most ${NOTES_MAX} characters.`).optional(),
    // Dispatch order (ADR-0047 c3/c5/c6) — nullable + optional (a PLANNED
    // create carries none; the order is required only at → OFFERED, enforced
    // by the superRefine + the service). materialNote qualifies OTHER; the
    // consignee/site-contact fields are Tier-2 PII (redacted in logs, never
    // in a URL). Both Create and Update carry every one of these — a field
    // missing from either 400s the request (the .strict() contract).
    materialType: MaterialTypeEnum.nullable().optional(),
    materialNote: MaterialNote.nullable().optional(),
    pickupSiteId: SiteId.nullable().optional(),
    dropoffSiteId: SiteId.nullable().optional(),
    consigneeName: ConsigneeName.nullable().optional(),
    consigneePhone: ConsigneePhone.nullable().optional(),
    expectedLoadCount: ExpectedLoadCount.nullable().optional(),
    specialInstructions: SpecialInstructions.nullable().optional(),
    docketNumber: DocketNumber.nullable().optional(),
    // Milestone timestamps (ADR-0047 c1/c3) — progress as timestamps, not
    // statuses. offeredAt/acceptedAt are normally SERVER-stamped on the
    // transition (the service), but accepted here too so a client can
    // back-date or the monotonic rule can see them.
    offeredAt: TripDateTime.nullable().optional(),
    acceptedAt: TripDateTime.nullable().optional(),
    arrivedPickupAt: TripDateTime.nullable().optional(),
    loadedAt: TripDateTime.nullable().optional(),
    arrivedDropoffAt: TripDateTime.nullable().optional(),
    deliveredAt: TripDateTime.nullable().optional(),
  })
  .strict()
  // The superRefine runs the meter-AGNOSTIC checks on the body (timing
  // presence + end-≥-start, the OFFERED order-required rule, and the
  // monotonic-milestone rule). It passes no meterType, so the meter-aware
  // required-reading rule is deferred to the service (TripsService.create /
  // .update), which looks up the vehicle's meterType — the body alone cannot
  // tell whether a missing odometer is wrong (km asset) or fine (hours asset).
  .superRefine((value, ctx) => {
    for (const message of validateTripCrossFields(value)) {
      ctx.addIssue({ code: "custom", message });
    }
  });

export type CreateTripInput = z.infer<typeof CreateTripSchema>;

// PATCH /api/v1/trips/:id body schema. Every field is optional (diff-
// PATCH semantics, as in DriversService.update). Cross-field rules
// CANNOT be enforced here because Zod sees only the partial body — a
// PATCH that sets `status: "COMPLETED"` without touching the other
// fields must be validated against the merged shape, not the body.
// The service is responsible for that merge-then-validate step using
// `validateTripCrossFields` directly. `.strict()` still rejects
// unexpected keys (including `createdById` and `id`).
export const UpdateTripSchema = z
  .object({
    vehicleId: z.string().min(1, "vehicleId must be non-empty."),
    driverId: z.string().min(1, "driverId must be non-empty."),
    status: z.enum(TRIP_STATUSES),
    startedAt: TripDateTime.nullable(),
    endedAt: TripDateTime.nullable(),
    startOdometerKm: OdometerInt.nullable(),
    endOdometerKm: OdometerInt.nullable(),
    // Engine-hours readings (ADR-0036) — see CreateTripSchema. `.partial()`
    // below makes every field optional for diff-PATCH semantics.
    startEngineHours: EngineHoursInt.nullable(),
    endEngineHours: EngineHoursInt.nullable(),
    notes: z.string().max(NOTES_MAX, `notes must be at most ${NOTES_MAX} characters.`),
    // Dispatch order + milestones (ADR-0047 W4) — the Update mirror of the
    // Create block above. `.nullable()` here (clear a field with explicit
    // null); `.partial()` below makes every field optional for diff-PATCH.
    // The order fields are how the admin dispatch UI (W6) attaches the order
    // on the PLANNED → OFFERED PATCH; the milestone timestamps are how the
    // driver app (W7/W8) records live progress. Cross-field rules (OFFERED
    // order-required, monotonic) run in the service against the MERGED shape.
    materialType: MaterialTypeEnum.nullable(),
    materialNote: MaterialNote.nullable(),
    pickupSiteId: SiteId.nullable(),
    dropoffSiteId: SiteId.nullable(),
    consigneeName: ConsigneeName.nullable(),
    consigneePhone: ConsigneePhone.nullable(),
    expectedLoadCount: ExpectedLoadCount.nullable(),
    specialInstructions: SpecialInstructions.nullable(),
    docketNumber: DocketNumber.nullable(),
    offeredAt: TripDateTime.nullable(),
    acceptedAt: TripDateTime.nullable(),
    arrivedPickupAt: TripDateTime.nullable(),
    loadedAt: TripDateTime.nullable(),
    arrivedDropoffAt: TripDateTime.nullable(),
    deliveredAt: TripDateTime.nullable(),
  })
  .strict()
  .partial();

export type UpdateTripInput = z.infer<typeof UpdateTripSchema>;

// Status-transition matrix for PATCH. CANCELLED is reachable from any
// non-terminal state (an operator may abort at any lifecycle stage).
//
// The dispatch lifecycle (ADR-0047 c1/c2/c7):
//   PLANNED → OFFERED → ACCEPTED → IN_PROGRESS → COMPLETED
// with two deliberate extra edges:
//   - PLANNED → IN_PROGRESS is KEPT (back-compat / admin-quick "just send a
//     truck" trips that skip the dispatch handshake — ADR-0047 c7). This is
//     why the trip-start SLI and the GPS ingest predicate are unaffected.
//   - OFFERED → PLANNED is the REASSIGN-BACK path. There is NO in-app decline
//     and NO `DECLINED` status (ADR-0047 c2, accept-only); a driver who cannot
//     take a trip is handled out-of-band and the admin pulls the offer back to
//     PLANNED (or re-offers by editing driver/vehicle on the OFFERED trip).
// ACCEPTED does NOT reach OFFERED again (re-offering edits the OFFERED/ACCEPTED
// trip's driver/vehicle in place, not via a status hop) and does NOT skip to
// COMPLETED. Jumping OFFERED → IN_PROGRESS or PLANNED → ACCEPTED is illegal —
// the driver must Accept before the trip can start. COMPLETED and CANCELLED are
// terminal (empty outbound lists): "uncompleting" a trip is illegal (correct a
// mis-marked trip by delete-and-recreate, preserving the audit trail).
//
// Self-transitions (e.g., IN_PROGRESS → IN_PROGRESS on a no-op PATCH) are
// allowed: the service-side `update()` treats the matrix as a guard on actual
// status CHANGES only (it routes through `has("status")` + `!== existing`).
//
// Exported so the service and its tests can share the source of truth.
export const TRIP_STATUS_TRANSITIONS: Record<
  (typeof TRIP_STATUSES)[number],
  readonly (typeof TRIP_STATUSES)[number][]
> = {
  PLANNED: ["OFFERED", "IN_PROGRESS", "CANCELLED"],
  OFFERED: ["ACCEPTED", "PLANNED", "CANCELLED"],
  ACCEPTED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

/**
 * Returns true if a transition from `from` to `to` is legal. Self-
 * transitions (from === to) are legal by convention so a PATCH that
 * resends an unchanged status field does not fail at this guard.
 */
export function isLegalTripStatusTransition(
  from: (typeof TRIP_STATUSES)[number],
  to: (typeof TRIP_STATUSES)[number],
): boolean {
  if (from === to) return true;
  return TRIP_STATUS_TRANSITIONS[from].includes(to);
}
