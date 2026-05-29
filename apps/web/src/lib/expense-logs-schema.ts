import { z } from "zod";

import { paisaToRupeesInput, rupeesToPaisa } from "./money";

// Web-side form schemas for the Expense-logs write path (iter 22).
// Mirrors the API's CreateExpenseLogSchema / UpdateExpenseLogSchema
// (apps/api/src/modules/expense-logs/expense-logs.schemas.ts) at the
// field level. The API is authoritative; these give the operator
// immediate inline feedback before a round-trip.
//
// Duplication-budget rationale matches fuel-logs-schema.ts / jobs-
// schema.ts / customers-schema.ts / trips-schema.ts: a shared
// workspace package is deferred; the API rejects anything sent
// incorrectly, so client drift is a UX cost, not a correctness one.
//
// Unit conversion at the form boundary:
//   - The wire stores amount as integer paisa (CLAUDE.md §"Money &
//     units"); the operator types rupees as a two-decimal-place
//     string (e.g. "1500.00"). The action layer multiplies by 100
//     and Math.rounds to the wire integer.
//   - Unlike Fuel logs, amountPaisa is AUTHORITATIVE — not derived
//     from a product of two factors. The form has a single `amount`
//     input and the action sends `amountPaisa` directly. There is
//     NO total-cost preview row on the form.
//
// Three structural divergences from the Fuel logs reference shape
// (per the iter-22 kickoff):
//
//   1. `amountPaisa` is authoritative — no derivation, no preview.
//      One `amount` decimal field → `rupeesToPaisa` at the action
//      boundary. Fuel logs splits cost into liters + price/liter
//      and renders a read-only computed preview; an expense is a
//      flat money value with no factor decomposition.
//
//   2. `vehicleId` is OPTIONAL on Create. The form's vehicle picker
//      includes a leading "— no vehicle —" option for vehicle-
//      agnostic expenses (the quarterly insurance premium, office
//      stationery). When the picker is "", the tripId picker must
//      also be cleared and disabled (a trip requires a vehicle
//      context). The action layer omits `vehicleId` from the body
//      when empty rather than sending "".
//
//   3. `vehicleId` is IMMUTABLE on Update — same rationale as Fuel
//      logs: once an expense is attributed to a vehicle, changing
//      the FK silently rewrites the per-vehicle cost report's
//      basis. The edit form does NOT render a vehicle picker; the
//      detail page shows the vehicle (read-only); to change the
//      vehicle binding the operator must delete and recreate. The
//      UpdateExpenseLogFormSchema does NOT include vehicleId at
//      all (defense in depth — the API's PATCH .strict() rejects
//      it independently).

// ---------------------------------------------------------------------
// Bounds — mirror the API's AMOUNT_PAISA / VENDOR / RECEIPT_NUMBER /
// NOTES limits after the human-units → integer conversion. Decimal
// bounds chosen so an operator-typed rounding-edge value parses
// cleanly.
// ---------------------------------------------------------------------

// 0.01 NPR = 1 paisa (the API's AMOUNT_PAISA_MIN).
// 100,000,000 NPR = 10_000_000_000 paisa (the API's AMOUNT_PAISA_MAX).
// Two decimals (the formatNpr precision; NPR has paisa-subunits).
const AMOUNT_DECIMAL_MIN = 0.01;
const AMOUNT_DECIMAL_MAX = 100_000_000;

const VENDOR_MAX = 256;
const RECEIPT_NUMBER_MAX = 64;
const NOTES_MAX = 4096;

// Eight ExpenseCategory enum values (mirror of the API's
// `import { ExpenseCategory } from "@prisma/client"` whitelist —
// duplicated here so the web does not import from @prisma/client
// directly). Adding a ninth value is a migration + a one-line
// addition here AND in types.ts's EXPENSE_CATEGORY_OPTIONS.
export const EXPENSE_CATEGORIES = [
  "MAINTENANCE",
  "REPAIR",
  "TOLL",
  "PARKING",
  "INSURANCE",
  "PERMIT",
  "FINE",
  "OTHER",
] as const;

export type ExpenseCategoryValue = (typeof EXPENSE_CATEGORIES)[number];

// `<input type="number" step="0.01">` produces a stringified decimal.
// We accept the string + parse / range-check inside the schema so the
// error message is operator-friendly. We bind the parsed number on the
// OUTPUT of the transform so RHF's resolved values are numbers; the
// action layer multiplies by 100 and Math.rounds to the wire integer.
function decimalString(opts: { min: number; max: number; fieldLabel: string; decimals: number }) {
  return z
    .string()
    .min(1, `${opts.fieldLabel} is required.`)
    .transform((raw, ctx): number => {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.fieldLabel} must be a number.`,
        });
        return z.NEVER;
      }
      if (n < opts.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.fieldLabel} must be ${opts.min} or greater.`,
        });
        return z.NEVER;
      }
      if (n > opts.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${opts.fieldLabel} must be ${opts.max} or less.`,
        });
        return z.NEVER;
      }
      // Check the decimal-place budget so an operator typing
      // "1500.123" for rupees (where the wire integer is paisa —
      // sub-paisa is meaningless) is caught at form-validation
      // time, not silently rounded away by the action layer.
      const dotIdx = raw.indexOf(".");
      if (dotIdx >= 0) {
        const fractionLen = raw.length - dotIdx - 1;
        if (fractionLen > opts.decimals) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${opts.fieldLabel} must have at most ${opts.decimals} decimal place${opts.decimals === 1 ? "" : "s"}.`,
          });
          return z.NEVER;
        }
      }
      return n;
    });
}

const OptionalTrimmedString = (max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((raw): string | undefined => {
      if (raw === undefined) return undefined;
      const t = raw.trim();
      if (t.length === 0) return undefined;
      return t;
    })
    .pipe(z.string().max(max, `${label} must be at most ${max} characters.`).optional());

// `<input type="date">` value: YYYY-MM-DD. Required on create; the
// shape lines up with the API's z.coerce.date() which accepts the same.
const RequiredDateString = z
  .string()
  .min(1, "Date is required.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.");

const OptionalDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Use the YYYY-MM-DD date format.")
  .optional();

const Category = z.enum(EXPENSE_CATEGORIES, { error: () => "Pick a category." });
const OptionalCategory = z.enum(EXPENSE_CATEGORIES).optional();

// ---------------------------------------------------------------------
// Create schema — POST. Required: date, category, amount.
// Optional: vehicleId (empty = vehicle-agnostic), tripId (empty = no
// trip), vendor, receiptNumber, notes.
//
// vehicleId is a STRING (cuid or "") rather than the Fuel logs
// `min(1)` because vehicle-agnostic expenses are first-class — the
// picker's leading "— no vehicle —" option submits "" and the action
// layer omits the key from the wire body.
// ---------------------------------------------------------------------

export const CreateExpenseLogFormSchema = z.object({
  // Empty string = "vehicle-agnostic expense". The action layer omits
  // the key when "".
  vehicleId: z.string().optional(),
  // Empty string = "no trip paired". The action layer omits the key
  // when "". The form additionally guarantees this is "" whenever
  // vehicleId is "" (trip requires vehicle context).
  tripId: z.string().optional(),
  date: RequiredDateString,
  category: Category,
  amount: decimalString({
    min: AMOUNT_DECIMAL_MIN,
    max: AMOUNT_DECIMAL_MAX,
    fieldLabel: "Amount",
    decimals: 2,
  }),
  vendor: OptionalTrimmedString(VENDOR_MAX, "Vendor"),
  receiptNumber: OptionalTrimmedString(RECEIPT_NUMBER_MAX, "Receipt number"),
  notes: OptionalTrimmedString(NOTES_MAX, "Notes"),
});

// Output (after resolve): amount is a number; optional text fields are
// string | undefined; vehicleId / tripId are string | undefined (the
// form binds them as strings).
export type CreateExpenseLogFormValues = z.infer<typeof CreateExpenseLogFormSchema>;

// Input (the raw form-field values RHF binds to <input>s). Every field
// is a string at the DOM level. This is the shape useForm<...> should
// be parametrized with so the inputs accept "".
export type CreateExpenseLogFormInput = z.input<typeof CreateExpenseLogFormSchema>;

// ---------------------------------------------------------------------
// Update schema — PATCH. Every mutable field optional (diff-PATCH
// semantics, mirror of UpdateFuelLogFormSchema / UpdateJobFormSchema).
//
// `vehicleId` is NOT in the shape — immutable (the API's PATCH
// .strict() rejects it; defense in depth here). `tripId` IS in the
// shape — mutable.
// ---------------------------------------------------------------------

// Re-state the create fields as `.optional()` for the update shape.
// We cannot `.partial()` the create schema directly because several of
// its fields are transform pipes; reconstructing here keeps the shape
// legible and the error messages consistent.
export const UpdateExpenseLogFormSchema = z.object({
  tripId: z.string().optional(),
  date: OptionalDateString,
  category: OptionalCategory,
  amount: z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Amount must be a number." });
        return z.NEVER;
      }
      if (n < AMOUNT_DECIMAL_MIN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Amount must be ${AMOUNT_DECIMAL_MIN} or greater.`,
        });
        return z.NEVER;
      }
      if (n > AMOUNT_DECIMAL_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Amount must be ${AMOUNT_DECIMAL_MAX} or less.`,
        });
        return z.NEVER;
      }
      const dotIdx = raw.indexOf(".");
      if (dotIdx >= 0 && raw.length - dotIdx - 1 > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Amount must have at most 2 decimal places.",
        });
        return z.NEVER;
      }
      return n;
    }),
  vendor: OptionalTrimmedString(VENDOR_MAX, "Vendor"),
  receiptNumber: OptionalTrimmedString(RECEIPT_NUMBER_MAX, "Receipt number"),
  notes: OptionalTrimmedString(NOTES_MAX, "Notes"),
});

export type UpdateExpenseLogFormValues = z.infer<typeof UpdateExpenseLogFormSchema>;
export type UpdateExpenseLogFormInput = z.input<typeof UpdateExpenseLogFormSchema>;

// ---------------------------------------------------------------------
// Wire converters — turn the human-decimal form value into the integer
// paisa the API expects. Used by the action layer. We re-export
// rupeesToPaisa and paisaToRupeesInput from the canonical `./money`
// module rather than duplicating them; they are generic NPR
// decimal-rupees↔integer-paisa helpers with no expense-specific
// semantics. (They previously lived in `./fuel-logs-schema`; relocating
// them to `./money` discharged a tech-debt entry — see
// docs/tech-debt.md.)
// ---------------------------------------------------------------------

export { rupeesToPaisa, paisaToRupeesInput };
