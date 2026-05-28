import { ExpenseCategory } from "@prisma/client";
import { z } from "zod";

// Zod schemas for the Expense-logs slice. Iter 21 ships the read path
// (ListExpenseLogsQuerySchema only); iter 22 will layer the write
// schemas (CreateExpenseLogSchema, UpdateExpenseLogSchema) into the
// same file alongside this one — the same one-file-per-slice
// convention every other vertical-slice module uses.
//
// Mirrors apps/api/src/modules/fuel-logs/fuel-logs.schemas.ts (iter
// 19 → iter 20) in shape and convention. The iter-21 kickoff names
// the Fuel logs read path as the canonical reference shape — same
// `.strict()` discipline (a typo'd key surfaces as HTTP 400), the
// same intParam helper for coerced bounds, and the same per-aggregate
// MAX_TAKE that mirrors the service-side LIST_TAKE_MAX.
//
// The one shape difference from FuelLog is the new `category` filter
// against the eight-value ExpenseCategory enum (see model docstring
// in apps/api/prisma/schema.prisma for the rationale). The enum is
// imported from @prisma/client so a future migration that adds a
// ninth value automatically widens the filter's whitelist; the web
// list page's native <select> picker stays the source-of-truth for
// the eight human-readable labels.

// Whitelist of sortable columns. The iter-21 ticket scopes sorts to
// `date` (the default), `amountPaisa`, and `createdAt`. `amountPaisa`
// is in the whitelist (a notable difference from Fuel logs, which
// keeps litersMl off the sort list) because the per-vehicle cost
// report wants "biggest expense first" as a routine query and we'd
// rather expose it via the list endpoint than add a dedicated
// reports route this iter. The category / vendor / receiptNumber /
// notes columns are NOT sortable — same `sortBy=notes` defense the
// Fuel logs / Jobs / Trips schemas apply, except here it covers
// `vendor` and `receiptNumber` too (vendor identity ordering would
// leak information without serving a clear operator need).
const SORTABLE_COLUMNS = ["date", "amountPaisa", "createdAt"] as const;
export type ExpenseLogSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type ExpenseLogSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from expense-logs.service.ts on
// purpose: the service is the runtime authority (the schema can
// only validate what the client sent; it cannot speak for the
// database). Both constants must move together when one changes;
// the same coupling fuel-logs.schemas.ts / jobs.schemas.ts document.
const QUERY_MAX_TAKE = 200;

// Coerce a string-typed query param to a non-negative integer with
// bounds checking. Same shape as the Fuel logs / Jobs / Trips schema
// helper; out-of-range values return 400 with a clear message rather
// than being silently clamped — a deliberate `take=10000` clamped to
// 200 would surprise an API consumer who expected to receive what
// they asked for.
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

// `vehicleId` / `tripId` filters: cuid-shaped, single value. Same
// shape Fuel logs uses; an empty string after `optional()` is
// normalized to `undefined` so the service omits the filter rather
// than asking Prisma for `where vehicleId = ''`.
//
// Note: even though ExpenseLog.vehicleId is nullable on the schema
// (a vehicle-agnostic expense is a valid row), the QUERY filter
// `?vehicleId=<id>` is positive-equality only — it matches rows
// where vehicleId equals the supplied id. Asking the list endpoint
// for "the vehicle-agnostic feed" (i.e. vehicleId IS NULL) is not
// exposed via this query schema in iter 21; the iter-23 cost report
// will surface that bucket explicitly via its own endpoint. The web
// list page's empty `vehicleId` filter renders all rows (filter
// omitted), which is the right default for the global expense feed.
const CuidFilter = z
  .string()
  .optional()
  .transform((raw, ctx): string | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
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

// Category filter: optional, must be one of the eight ExpenseCategory
// enum values. The enum is imported from the generated Prisma client
// so adding a ninth value via a future migration automatically widens
// this whitelist — no second source-of-truth to keep in sync. An
// out-of-enum value returns 400 with the standard Zod enum error
// (`Invalid enum value` + the legal list).
const CategoryFilter = z.enum(ExpenseCategory).optional();

export const ListExpenseLogsQuerySchema = z
  .object({
    vehicleId: CuidFilter,
    tripId: CuidFilter,
    category: CategoryFilter,
    startDate: DateFilter,
    endDate: DateFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?vehicelId=...`) surfaces
  // as 400 rather than being silently ignored. Matches the Fuel
  // logs / Jobs / Trips / Customers contracts.
  .strict();

export type ListExpenseLogsQuery = z.infer<typeof ListExpenseLogsQuerySchema>;

// ---------------------------------------------------------------------
// Iter 22 placeholder — write-path schemas land here.
// ---------------------------------------------------------------------
// The iter-22 write path will add `CreateExpenseLogSchema` and
// `UpdateExpenseLogSchema` below, mirroring the Fuel logs iter-20
// write schemas. Notable differences vs. Fuel logs:
//
//   - `vehicleId` is OPTIONAL + NULLABLE on the create body. The
//     CEO can log a vehicle-agnostic expense (the quarterly
//     insurance premium, office stationery) and the create form's
//     vehicle picker will include an explicit "(none — not
//     vehicle-attributable)" option.
//
//   - `vehicleId` becomes IMMUTABLE post-create on PATCH (the same
//     `.strict()` rejection FuelLog uses, for the same "rewriting
//     history" rationale — once an expense is attributed to a
//     vehicle, changing the FK silently rewrites the per-vehicle
//     cost report's basis; re-create the expense against the
//     correct vehicle when the operator realises the original was
//     mis-attributed).
//
//   - `tripId` stays MUTABLE on PATCH (same reasoning as Fuel logs:
//     pairing / unpairing an expense with a trip is a routine
//     post-create correction).
//
//   - No derived-field rule (the Fuel logs `totalCostPaisa`
//     equivalent does not exist here; `amountPaisa` is the
//     authoritative entered value, not a product of two factors).
