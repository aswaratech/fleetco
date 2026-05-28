import { z } from "zod";

// Web-side form schemas for the Fuel-logs write path (iter 20). Mirrors
// the API's CreateFuelLogSchema / UpdateFuelLogSchema (apps/api/src/
// modules/fuel-logs/fuel-logs.schemas.ts) at the field level. The API
// is authoritative; these give the operator immediate inline feedback
// before a round-trip.
//
// Duplication-budget rationale matches jobs-schema.ts / customers-
// schema.ts / trips-schema.ts: a shared workspace package is deferred;
// the API rejects anything sent incorrectly, so client drift is a UX
// cost, not a correctness one. The shared package becomes worthwhile
// when the driver app (Phase 2) needs to re-use these shapes.
//
// Unit conversion at the form boundary:
//   - The wire stores volume as integer milliliters (CLAUDE.md §"Money
//     & units"); the operator types liters as a decimal (e.g. "12.345").
//   - The wire stores price as integer paisa; the operator types rupees
//     as a decimal (e.g. "150.00").
//   - The form schemas accept the human strings, validate the decimal
//     bounds, and the action layer (apps/web/src/app/fuel-logs/
//     actions.ts) converts to integer mL / paisa via Math.round before
//     the POST/PATCH. The integer ceilings here mirror the API's
//     LITERS_ML_MAX / PRICE_PAISA_MAX after the conversion.
//
// `totalCostPaisa` is intentionally NOT in either schema. It is derived
// server-side (Math.round(litersMl * pricePerLiterPaisa / 1000)) and
// the API's `.strict()` rejects any client attempt to set it. The
// create / edit forms render a read-only preview computed from the
// current liters + price inputs so the operator can spot a typo before
// submitting; the preview helper lives below.
//
// `vehicleId` is in the create schema only (immutable post-create;
// the API's PATCH .strict() rejects it). `tripId` is in both (mutable
// on PATCH — a fill may be paired with a trip after the trip is
// created, or unpaired if the receipt belongs to a different journey).

// ---------------------------------------------------------------------
// Bounds — mirror the API's LITERS_ML / PRICE_PAISA / ODOMETER /
// STATION / RECEIPT_NUMBER / NOTES limits after the human-units →
// integer conversion. Decimal bounds chosen so an operator-typed
// rounding-edge value (e.g. 100000.0 L exactly) parses cleanly.
// ---------------------------------------------------------------------

// 0.001 L = 1 mL (the API's LITERS_ML_MIN). 1,000,000 L = the API's
// LITERS_ML_MAX (1_000_000_000 mL). We accept three decimals (matching
// formatLiters' display precision).
const LITERS_DECIMAL_MIN = 0.001;
const LITERS_DECIMAL_MAX = 1_000_000;

// 0.01 NPR = 1 paisa (the API's PRICE_PAISA_MIN). 100,000 NPR =
// 10_000_000 paisa (the API's PRICE_PAISA_MAX). Two decimals (the
// formatNpr precision; NPR has paisa-subunits).
const PRICE_DECIMAL_MIN = 0.01;
const PRICE_DECIMAL_MAX = 100_000;

// Odometer is already in km (integer) — no conversion. Bounds mirror
// the API.
const ODOMETER_MIN = 0;
const ODOMETER_MAX = 100_000_000;

const STATION_MAX = 256;
const RECEIPT_NUMBER_MAX = 64;
const NOTES_MAX = 4096;

// `<input type="number" step="0.001">` produces a stringified decimal.
// We accept the string + parse / range-check inside the schema so the
// error message is operator-friendly. Empty string is the "not entered"
// state (used by optional fields).
//
// We bind the parsed number on the OUTPUT of the transform so RHF's
// resolved values are numbers; the action layer multiplies by 1000 (mL)
// or 100 (paisa) and Math.rounds to the wire integer.
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
      // Check the decimal-place budget so an operator typing "12.3456"
      // for liters (where the wire integer is mL — fourth-decimal-place
      // sub-milliliter is meaningless) is caught at form-validation
      // time, not silently rounded away by the action layer. The check
      // is on the *string* (n.toFixed(decimals) would re-introduce
      // floating-point rounding artifacts).
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

// Optional integer odometer — empty string means "no reading on file".
// Accepts a numeric string, range-checks, returns the integer or
// `undefined` for empty. PATCH semantics: empty becomes null on the
// wire (the action layer translates "" → null for nullable fields).
const OptionalOdometerString = z
  .string()
  .optional()
  .transform((raw, ctx): number | undefined => {
    if (raw === undefined || raw === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Odometer reading must be an integer (km).",
      });
      return z.NEVER;
    }
    if (n < ODOMETER_MIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Odometer reading must be ${ODOMETER_MIN} or greater.`,
      });
      return z.NEVER;
    }
    if (n > ODOMETER_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Odometer reading must be ${ODOMETER_MAX} or less.`,
      });
      return z.NEVER;
    }
    return n;
  });

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

// ---------------------------------------------------------------------
// Create schema — POST. Required: vehicleId, date, liters, price.
// Optional: tripId, odometer, station, receiptNumber, notes.
// ---------------------------------------------------------------------

export const CreateFuelLogFormSchema = z.object({
  vehicleId: z.string().min(1, "Pick a vehicle."),
  // Empty string = "no trip paired". The action layer omits the key.
  tripId: z.string().optional(),
  date: RequiredDateString,
  liters: decimalString({
    min: LITERS_DECIMAL_MIN,
    max: LITERS_DECIMAL_MAX,
    fieldLabel: "Liters",
    decimals: 3,
  }),
  pricePerLiter: decimalString({
    min: PRICE_DECIMAL_MIN,
    max: PRICE_DECIMAL_MAX,
    fieldLabel: "Price per liter",
    decimals: 2,
  }),
  odometerReadingKm: OptionalOdometerString,
  station: OptionalTrimmedString(STATION_MAX, "Station"),
  receiptNumber: OptionalTrimmedString(RECEIPT_NUMBER_MAX, "Receipt number"),
  notes: OptionalTrimmedString(NOTES_MAX, "Notes"),
});

// Output (after resolve): liters / pricePerLiter are numbers; optional
// text fields are string | undefined; optional integer fields are
// number | undefined.
export type CreateFuelLogFormValues = z.infer<typeof CreateFuelLogFormSchema>;

// Input (the raw form-field values RHF binds to <input>s). Every field
// is a string at the DOM level. This is the shape useForm<...> should
// be parametrized with so the inputs accept "".
export type CreateFuelLogFormInput = z.input<typeof CreateFuelLogFormSchema>;

// ---------------------------------------------------------------------
// Update schema — PATCH. Every mutable field optional (diff-PATCH
// semantics, mirror of UpdateJobFormSchema).
//
// `vehicleId` is NOT in the shape — immutable. `tripId` IS in the
// shape — mutable. `liters` / `pricePerLiter` re-derive
// totalCostPaisa server-side when either is touched (the API service
// re-computes against the merged shape).
// ---------------------------------------------------------------------

// Re-state the create fields as `.optional()` for the update shape.
// We cannot `.partial()` the create schema directly because several
// of its fields are transform pipes; reconstructing here keeps the
// shape legible and the error messages consistent.
export const UpdateFuelLogFormSchema = z.object({
  tripId: z.string().optional(),
  date: OptionalDateString,
  liters: z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Liters must be a number." });
        return z.NEVER;
      }
      if (n < LITERS_DECIMAL_MIN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Liters must be ${LITERS_DECIMAL_MIN} or greater.`,
        });
        return z.NEVER;
      }
      if (n > LITERS_DECIMAL_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Liters must be ${LITERS_DECIMAL_MAX} or less.`,
        });
        return z.NEVER;
      }
      const dotIdx = raw.indexOf(".");
      if (dotIdx >= 0 && raw.length - dotIdx - 1 > 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Liters must have at most 3 decimal places.",
        });
        return z.NEVER;
      }
      return n;
    }),
  pricePerLiter: z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Price per liter must be a number.",
        });
        return z.NEVER;
      }
      if (n < PRICE_DECIMAL_MIN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Price per liter must be ${PRICE_DECIMAL_MIN} or greater.`,
        });
        return z.NEVER;
      }
      if (n > PRICE_DECIMAL_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Price per liter must be ${PRICE_DECIMAL_MAX} or less.`,
        });
        return z.NEVER;
      }
      const dotIdx = raw.indexOf(".");
      if (dotIdx >= 0 && raw.length - dotIdx - 1 > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Price per liter must have at most 2 decimal places.",
        });
        return z.NEVER;
      }
      return n;
    }),
  odometerReadingKm: OptionalOdometerString,
  station: OptionalTrimmedString(STATION_MAX, "Station"),
  receiptNumber: OptionalTrimmedString(RECEIPT_NUMBER_MAX, "Receipt number"),
  notes: OptionalTrimmedString(NOTES_MAX, "Notes"),
});

export type UpdateFuelLogFormValues = z.infer<typeof UpdateFuelLogFormSchema>;
export type UpdateFuelLogFormInput = z.input<typeof UpdateFuelLogFormSchema>;

// ---------------------------------------------------------------------
// Wire converters — turn the human-decimal form values into the
// integer mL / paisa the API expects. Used by the action layer.
// Math.round (half-up) matches the API's deriveTotalCostPaisa
// rounding — keeping the same rounding rule on both sides of the wire
// means the operator's preview matches the persisted value bit-for-bit.
// ---------------------------------------------------------------------

export function litersToMl(liters: number): number {
  return Math.round(liters * 1000);
}

export function rupeesToPaisa(rupees: number): number {
  return Math.round(rupees * 100);
}

// Preview helper: compute the total-cost preview the create / edit
// forms render as a read-only paisa value, given the parsed decimal
// liters + price. The form passes nulls when either field is not yet
// valid; this returns null in that case so the preview renders as the
// em-dash.
export function previewTotalCostPaisa(
  liters: number | null,
  pricePerLiter: number | null,
): number | null {
  if (liters === null || pricePerLiter === null) return null;
  if (!Number.isFinite(liters) || !Number.isFinite(pricePerLiter)) return null;
  // Same formula as the API: round(litersMl * pricePerLiterPaisa /
  // 1000). Computed directly from the decimal inputs without an
  // intermediate integer round-trip — algebraically identical for
  // operator-typed values.
  return Math.round(liters * pricePerLiter * 100);
}

// Inverse helpers for the edit form's defaultValues — turn the persisted
// integer mL / paisa back into the operator-readable decimal strings the
// form inputs accept. We do NOT use formatLiters / formatNpr here: those
// helpers add the unit suffix and locale grouping, neither of which an
// `<input type="number">` accepts.
export function mlToLitersInput(ml: number): string {
  // mL → L with three decimals. toFixed(3) preserves trailing zeros
  // (e.g. 12000 → "12.000") which is fine for `<input type="number">`.
  return (ml / 1000).toFixed(3);
}

export function paisaToRupeesInput(paisa: number): string {
  return (paisa / 100).toFixed(2);
}
