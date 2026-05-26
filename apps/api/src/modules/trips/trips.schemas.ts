import { z } from "zod";

// Zod schemas for the Trips slice — iter 8 ships the read path only
// (ListTripsQuerySchema). The iter-9 write path will add
// CreateTripSchema and UpdateTripSchema next to this file, mirroring
// the Drivers iter-6/iter-7 staging.
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
