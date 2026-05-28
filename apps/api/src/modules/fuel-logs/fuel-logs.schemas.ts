import { z } from "zod";

// Zod schemas for the Fuel-logs slice — iter 19 ships the read path
// (ListFuelLogsQuerySchema). Iter 20 will add the write path
// (CreateFuelLogSchema, UpdateFuelLogSchema) including the
// write-time totalCostPaisa derivation; the create / update wire
// shapes are intentionally left for that iter so the read-path PR
// reviewers see the read contract in isolation.
//
// Mirrors apps/api/src/modules/jobs/jobs.schemas.ts (iter 17) in
// shape and convention — the iter-19 kickoff calls out the Jobs
// read-path as the reference shape. Same `.strict()` discipline, the
// same intParam helper for coerced bounds, and the same per-aggregate
// MAX_TAKE that mirrors the service-side LIST_TAKE_MAX.

// Whitelist of sortable columns. The iter-19 ticket explicitly scopes
// sorts to `date` and `createdAt` — the Vehicle and Liters columns are
// not sortable in iter 19 (keeping scope tight; sorting on litersMl
// would invite "sort by what unit?" UX questions a future iter can
// address alongside the per-vehicle km/L reports). Allowing arbitrary
// columns would also invite expensive sorts and accidental information
// disclosure on free-form text columns (`sortBy=notes` is the same
// defense the Trips / Jobs schemas document).
const SORTABLE_COLUMNS = ["date", "createdAt"] as const;
export type FuelLogSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type FuelLogSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from fuel-logs.service.ts on purpose:
// the service is the runtime authority (the schema can only validate
// what the client sent; it cannot speak for the database). Both
// constants must move together when one changes; the same coupling
// jobs.schemas.ts / trips.schemas.ts document.
const QUERY_MAX_TAKE = 200;

// Coerce a string-typed query param to a non-negative integer with
// bounds checking. Same shape as the Jobs / Trips schema helper;
// out-of-range values return 400 with a clear message rather than
// being silently clamped — a deliberate `take=10000` clamped to 200
// would surprise an API consumer who expected to receive what they
// asked for.
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
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${max} or less.` });
        return z.NEVER;
      }
      return n;
    });
}

// `vehicleId` / `tripId` filters: cuid-shaped, single value. The
// iter-19 ticket scopes these to cuid; this is a tighter contract
// than the Jobs `customerId` filter (which accepts any string) but
// the Fuel-log read path adds two FK filters at once and the cuid
// guard prevents `?vehicleId=&tripId=` from producing two empty-
// string equality filters in the service. An empty string after the
// `optional()` is normalized to `undefined` so the service omits the
// filter rather than asking Prisma for `where vehicleId = ''`.
const CuidFilter = z
  .string()
  .optional()
  .transform((raw, ctx): string | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    // cuid format check — minimal: starts with 'c', alphanumeric,
    // 24+ chars. We do not pull zod's z.string().cuid() because the
    // Prisma cuid() default produces strings that the strict v2
    // checker rejects in some toolchain versions. The loose check
    // here is enough to keep accidental query-string garbage out
    // without rejecting legitimate ids.
    if (!/^c[a-z0-9]{8,}$/i.test(trimmed)) {
      ctx.addIssue({ code: "custom", message: "Must be a valid id." });
      return z.NEVER;
    }
    return trimmed;
  });

// Date-range filters. `z.coerce.date()` accepts YYYY-MM-DD and ISO
// 8601 timestamps; an invalid value (e.g., "not-a-date") fails the
// parse. The bounds are inclusive at the service layer (gte / lte).
const DateFilter = z.coerce
  .date({ error: () => "Must be a valid date (YYYY-MM-DD or ISO 8601)." })
  .optional();

export const ListFuelLogsQuerySchema = z
  .object({
    vehicleId: CuidFilter,
    tripId: CuidFilter,
    startDate: DateFilter,
    endDate: DateFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?vehicelId=...`) surfaces as
  // 400 rather than being silently ignored. Matches the Jobs / Trips /
  // Customers contracts.
  .strict();

export type ListFuelLogsQuery = z.infer<typeof ListFuelLogsQuerySchema>;
