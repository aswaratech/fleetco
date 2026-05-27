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
const TRIP_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;

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
}

/**
 * Validate the trip cross-field rules against a merged shape. Returns
 * a list of human-readable error messages; an empty array means valid.
 *
 * Rules:
 *   - IN_PROGRESS: startedAt and startOdometerKm MUST be set.
 *   - COMPLETED:   all four start/end fields MUST be set;
 *                  endOdometerKm >= startOdometerKm;
 *                  endedAt >= startedAt.
 *   - PLANNED / CANCELLED: no constraint (a planned trip may have
 *     startedAt prefilled for scheduling; a cancelled trip may have
 *     been cancelled at any lifecycle stage and so any combination of
 *     timing fields is legitimate).
 *
 * The service calls this after merging a PATCH; the schema calls this
 * (via superRefine) on the body alone — for `create` that is also the
 * full shape, so the two callsites converge.
 */
export function validateTripCrossFields(shape: TripCrossFieldShape): string[] {
  const errors: string[] = [];
  const { status, startedAt, endedAt, startOdometerKm, endOdometerKm } = shape;
  const hasStartedAt = startedAt !== null && startedAt !== undefined;
  const hasEndedAt = endedAt !== null && endedAt !== undefined;
  const hasStartOdo = startOdometerKm !== null && startOdometerKm !== undefined;
  const hasEndOdo = endOdometerKm !== null && endOdometerKm !== undefined;

  if (status === "IN_PROGRESS") {
    if (!hasStartedAt) {
      errors.push("startedAt is required when status is IN_PROGRESS.");
    }
    if (!hasStartOdo) {
      errors.push("startOdometerKm is required when status is IN_PROGRESS.");
    }
  }
  if (status === "COMPLETED") {
    if (!hasStartedAt) errors.push("startedAt is required when status is COMPLETED.");
    if (!hasEndedAt) errors.push("endedAt is required when status is COMPLETED.");
    if (!hasStartOdo) errors.push("startOdometerKm is required when status is COMPLETED.");
    if (!hasEndOdo) errors.push("endOdometerKm is required when status is COMPLETED.");
    if (hasStartOdo && hasEndOdo) {
      const start = startOdometerKm as number;
      const end = endOdometerKm as number;
      if (end < start) {
        errors.push("endOdometerKm must be greater than or equal to startOdometerKm.");
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
    notes: z.string().max(NOTES_MAX, `notes must be at most ${NOTES_MAX} characters.`).optional(),
  })
  .strict()
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
    notes: z.string().max(NOTES_MAX, `notes must be at most ${NOTES_MAX} characters.`),
  })
  .strict()
  .partial();

export type UpdateTripInput = z.infer<typeof UpdateTripSchema>;

// Status-transition matrix for PATCH. CANCELLED is reachable from any
// state (an operator may abort at any lifecycle stage). Other
// transitions follow the lifecycle: PLANNED → IN_PROGRESS → COMPLETED.
// Jumping PLANNED → COMPLETED directly is illegal because it implies
// the operator never recorded that the trip started, which would
// corrupt downstream reporting on average trip duration.
//
// Self-transitions (e.g., IN_PROGRESS → IN_PROGRESS on a no-op PATCH)
// are allowed: the service-side `update()` treats the matrix as a
// guard on actual changes only.
//
// Exported so the service and its tests can share the source of truth.
export const TRIP_STATUS_TRANSITIONS: Record<
  (typeof TRIP_STATUSES)[number],
  readonly (typeof TRIP_STATUSES)[number][]
> = {
  PLANNED: ["IN_PROGRESS", "CANCELLED"],
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
