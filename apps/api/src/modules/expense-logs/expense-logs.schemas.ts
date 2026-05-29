import { ExpenseCategory } from "@prisma/client";
import { z } from "zod";

// Zod schemas for the Expense-logs slice. Iter 21 shipped the read
// path (ListExpenseLogsQuerySchema); iter 22 layers the write schemas
// (CreateExpenseLogSchema, UpdateExpenseLogSchema) into the same file
// alongside this one — the same one-file-per-slice convention every
// other vertical-slice module uses.
//
// Mirrors apps/api/src/modules/fuel-logs/fuel-logs.schemas.ts (iter
// 19 → iter 20) in shape and convention. The iter-22 kickoff names
// the Fuel logs write path as the canonical reference shape — same
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
// Write-path schemas (iter 22) — POST and PATCH bodies.
// ---------------------------------------------------------------------
//
// Both schemas are `.strict()` so an unexpected key (e.g. a client
// trying to set `createdById` directly, or a typo'd field name)
// surfaces as HTTP 400 with a clear message rather than being
// silently dropped. Two server-controlled fields rely on this
// strictness:
//
//   - `createdById` is derived from the authenticated session and
//     must never be accepted from the wire (same rule every other
//     aggregate enforces — Vehicles, Drivers, Customers, Jobs,
//     Trips, Fuel logs).
//
//   - `id` / `createdAt` / `updatedAt` are out of scope on the wire
//     by Prisma convention. The `.strict()` enforces it.
//
// Notable shape differences vs. the Fuel logs iter-20 write schemas
// the iter-22 kickoff points at as the reference shape:
//
//   - `vehicleId` is OPTIONAL + NULLABLE on POST. The CEO can log a
//     vehicle-agnostic expense (the quarterly insurance premium,
//     office stationery) and the create form's vehicle picker
//     includes an explicit "(none — not vehicle-attributable)"
//     option. Fuel logs requires vehicleId because a fill is always
//     attributed to a tank.
//
//   - `vehicleId` is IMMUTABLE on PATCH (NOT in the update shape;
//     `.strict()` rejects it). Same "rewriting history" rationale
//     Fuel logs documents — once an expense is attributed to a
//     vehicle, changing the FK silently rewrites the per-vehicle
//     cost report's basis. Re-create the expense against the
//     correct vehicle when the operator realises the original was
//     mis-attributed.
//
//   - `tripId` is OPTIONAL + NULLABLE on POST and MUTABLE on PATCH
//     (same reasoning as Fuel logs: pairing / unpairing an expense
//     with a trip is a routine post-create correction).
//
//   - No derived field. Fuel logs' `totalCostPaisa` is computed
//     server-side from `litersMl * pricePerLiterPaisa / 1000`; the
//     `.strict()` blocks the wire from setting it. An expense log
//     has no equivalent: `amountPaisa` is the authoritative entered
//     value, not a product of two factors. The schema accepts
//     `amountPaisa` directly on both POST and PATCH.
//
//   - Cross-field rule (trip-vehicle consistency) fires only when
//     BOTH `tripId` AND `vehicleId` are present on the merged shape.
//     If either is null (or omitted on a PATCH that does not touch
//     them and the stored row is null), the check is skipped —
//     pairing a vehicle-agnostic expense with a trip is allowed, as
//     is logging a vehicle expense without trip attribution.

// Amount bounds (paisa, 1/100 NPR). Ceiling: NPR 100,000,000 =
// 10_000_000_000 paisa — well within JS safe-integer range and well
// above any realistic single expense; a typo'd extra digit (or a
// rupees-vs-paisa unit mistake) fails the schema rather than ending
// up in a per-vehicle cost report. Lower bound 1 paisa: a zero-amount
// expense is a corrupted record, not a legitimate one.
const AMOUNT_PAISA_MIN = 1;
const AMOUNT_PAISA_MAX = 10_000_000_000;

// Free-form text bounds. Vendor / receiptNumber / notes columns are
// `String?` (unbounded in Postgres); the ceilings here keep the
// surface predictable. Vendor is roomier than the Fuel logs
// `station` cap (256) because an expense vendor name often includes
// a full legal entity ("XYZ Auto Workshop and Service Center Pvt.
// Ltd."). ReceiptNumber stays tight (real-world receipts are 10–30
// chars); notes is roomy because the operator may attach context.
const VENDOR_MAX = 256;
const RECEIPT_NUMBER_MAX = 64;
const NOTES_MAX = 4096;

const AmountPaisa = z
  .number({ error: () => "amountPaisa must be an integer." })
  .int("amountPaisa must be an integer.")
  .min(AMOUNT_PAISA_MIN, `amountPaisa must be ${AMOUNT_PAISA_MIN} or greater.`)
  .max(AMOUNT_PAISA_MAX, `amountPaisa must be ${AMOUNT_PAISA_MAX} or less.`);

const Vendor = z
  .string()
  .trim()
  .max(VENDOR_MAX, `Vendor must be at most ${VENDOR_MAX} characters.`);

const ReceiptNumber = z
  .string()
  .trim()
  .max(RECEIPT_NUMBER_MAX, `Receipt number must be at most ${RECEIPT_NUMBER_MAX} characters.`);

const Notes = z.string().max(NOTES_MAX, `Notes must be at most ${NOTES_MAX} characters.`);

// `date` accepts YYYY-MM-DD or ISO 8601 strings (and any value that
// `new Date(...)` can parse). The coerced Date is what reaches the
// service. Mirror of the date helpers in fuel-logs.schemas.ts /
// jobs.schemas.ts.
const ExpenseLogDate = z.coerce.date({
  error: () => "Must be a valid date (YYYY-MM-DD or ISO 8601).",
});

// Category accepts any of the eight ExpenseCategory enum values.
// Same source-of-truth as the list filter — adding a ninth value
// via a future Prisma migration automatically widens both contracts.
const Category = z.enum(ExpenseCategory);

// cuid shape for write-path FK ids. Tighter than the Jobs
// `customerId` filter (which accepts any non-empty string) — the
// iter-22 write path scopes FK ids to cuid the same way the
// read-path filters do. The service translates an invalid (but
// cuid-shaped) id into a Prisma P2003 → 400 with a field-level
// error if it slips through.
const Cuid = z
  .string()
  .trim()
  .min(1, "Required.")
  .regex(/^c[a-z0-9]{8,}$/i, "Must be a valid id.");

/**
 * POST /api/v1/expense-logs body schema. Required: date, category,
 * amountPaisa. Optional + nullable: vehicleId (a vehicle-agnostic
 * expense like the quarterly insurance premium is a valid row),
 * tripId (an expense may or may not be paired with a trip), vendor,
 * receiptNumber, notes.
 *
 * `createdById` is excluded; the controller pulls it from the
 * authenticated session per ADR-0021.
 *
 * Cross-field rule: when BOTH `tripId` AND `vehicleId` are present,
 * the referenced Trip's `vehicleId` must match this expense log's
 * `vehicleId`. The check cannot run at the schema layer (it needs a
 * database lookup) and so is enforced at the service layer; see
 * ExpenseLogsService.create. When either is null/omitted, the check
 * is skipped — pairing a vehicle-agnostic expense with a trip is
 * allowed, and so is logging a vehicle expense without trip
 * attribution.
 */
export const CreateExpenseLogSchema = z
  .object({
    vehicleId: Cuid.nullable().optional(),
    tripId: Cuid.nullable().optional(),
    date: ExpenseLogDate,
    category: Category,
    amountPaisa: AmountPaisa,
    vendor: Vendor.nullable().optional(),
    receiptNumber: ReceiptNumber.nullable().optional(),
    notes: Notes.nullable().optional(),
  })
  .strict();

export type CreateExpenseLogInput = z.infer<typeof CreateExpenseLogSchema>;

/**
 * PATCH /api/v1/expense-logs/:id body schema. Every mutable field is
 * optional (diff-PATCH semantics, mirror of FuelLogsService.update /
 * JobsService.update / CustomersService.update).
 *
 * One immutable field is NOT in the shape and so `.strict()` rejects
 * any attempt to set it:
 *
 *   - `vehicleId` — an expense log records a fact about which
 *     vehicle the cost is attributed to. Changing the FK silently
 *     rewrites the per-vehicle cost report's basis (a maintenance
 *     bill that landed against vehicle A becomes a bill against
 *     vehicle B, and any report computed against the original FK
 *     becomes a lie). Re-creating the expense against the right
 *     vehicle is the right move when the operator realises the
 *     original was mis-attributed. Same precedent as the Jobs
 *     iter-18 immutability of `customerId` and the Fuel-logs
 *     iter-20 immutability of `vehicleId`.
 *
 * `tripId` IS in the shape: pairing / unpairing an expense with a
 * trip is a routine post-create correction (the operator may not
 * know which trip an expense belongs to until the trip is created
 * and they reconcile receipts). Setting tripId to null explicitly
 * clears the pairing. The service re-runs the trip-vehicle-
 * consistency check against the merged shape (stored row + patch)
 * when tripId is touched and both tripId and vehicleId end up
 * non-null on the merged shape.
 */
export const UpdateExpenseLogSchema = z
  .object({
    tripId: Cuid.nullable().optional(),
    date: ExpenseLogDate.optional(),
    category: Category.optional(),
    amountPaisa: AmountPaisa.optional(),
    vendor: Vendor.nullable().optional(),
    receiptNumber: ReceiptNumber.nullable().optional(),
    notes: Notes.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateExpenseLogInput = z.infer<typeof UpdateExpenseLogSchema>;
