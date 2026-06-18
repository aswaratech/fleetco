import { z } from "zod";

import { hoursToTenths, tenthsToHoursInput } from "./units";

// Web-side form schema + conversion helpers for the ServiceRecord aggregate
// (ADR-0037 / Program B, B5). Mirrors the API's authoritative schemas
// (apps/api/src/modules/maintenance/service-records.schemas.ts) at the field
// level. The API is authoritative; these give the operator immediate inline
// feedback before a round-trip.
//
// A ServiceRecord is a completed service event — the maintenance history. It
// carries the meter reading(s) captured at service + a performedAt date, an
// optional link to the ServiceSchedule it satisfies (null = an ad-hoc / one-off
// service), an optional link to the ExpenseLog that holds its cost (null = a
// warranty service, or the invoice is not keyed yet — ADR-0037 c6), and
// optional notes. vehicleId is required and immutable on PATCH.
//
// Every field is a string at the DOM (no transforms beyond trim) so RHF binds it
// directly; the action layer parses + converts. Meter readings cross the
// integer-minor-units boundary exactly as the schedule form: odometer is integer
// km, engine-hours are entered as decimal hours and converted to integer tenths
// via the shipped `hoursToTenths`. The schedule↔vehicle and expense↔vehicle
// consistency rules (ADR-0037 c5/c6) need DB lookups and so live at the API
// service layer; the API 400s are mapped to the right picker in actions.ts.

const NOTES_MAX = 4096;
const ODOMETER_MIN = 0;
const ODOMETER_MAX = 100_000_000;
const HOURS_MIN = 0;
const HOURS_MAX = 10_000_000;

// `<input type="date">` / NepaliDatePicker value: YYYY-MM-DD. Required on create
// (a completed service happened at a known time); optional on update.
const RequiredDateString = z
  .string()
  .min(1, "Date is required.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.");
const OptionalDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Use the YYYY-MM-DD date format.")
  .optional();

interface NumericRule {
  min: number;
  max: number;
  decimals: number;
  label: string;
  path: string;
}

// Shared numeric-string validator: skips the empty string (these readings are
// optional), then checks finiteness, decimal budget, and bounds, attaching any
// issue to the named path. Mirror of the helper in service-schedules-schema.ts.
function checkNumeric(raw: string, rule: NumericRule, ctx: z.RefinementCtx): void {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  const n = Number(trimmed);
  const add = (message: string): void => {
    ctx.addIssue({ code: "custom", message, path: [rule.path] });
  };
  if (!Number.isFinite(n)) {
    add(`${rule.label} must be a number.`);
    return;
  }
  const dotIdx = trimmed.indexOf(".");
  if (rule.decimals === 0) {
    if (dotIdx >= 0) {
      add(`${rule.label} must be a whole number.`);
      return;
    }
  } else if (dotIdx >= 0 && trimmed.length - dotIdx - 1 > rule.decimals) {
    add(
      `${rule.label} must have at most ${rule.decimals} decimal place${rule.decimals === 1 ? "" : "s"}.`,
    );
    return;
  }
  if (n < rule.min) {
    add(`${rule.label} must be ${rule.min} or greater.`);
    return;
  }
  if (n > rule.max) {
    add(`${rule.label} must be ${rule.max} or less.`);
  }
}

const Notes = z
  .string()
  .max(NOTES_MAX, `Notes must be at most ${NOTES_MAX} characters.`)
  .optional();

// Inverse of hoursToTenths for the edit form's defaultValues — the persisted
// integer tenths back to the one-decimal string the form input accepts.
export { tenthsToHoursInput };

// ---------------------------------------------------------------------
// Create form schema — POST. Required: vehicleId, performedAt. Optional:
// serviceScheduleId ("" = ad-hoc), expenseLogId ("" = no cost link),
// odometerKm, engineHours (decimal hours), notes. The object superRefine
// validates the two meter readings against their bounds.
// ---------------------------------------------------------------------

export const CreateServiceRecordFormSchema = z
  .object({
    vehicleId: z.string().min(1, "Pick a vehicle."),
    serviceScheduleId: z.string().optional(),
    expenseLogId: z.string().optional(),
    performedAt: RequiredDateString,
    odometerKm: z.string().optional(),
    engineHours: z.string().optional(),
    notes: Notes,
  })
  .superRefine((v, ctx) => {
    checkNumeric(
      v.odometerKm ?? "",
      {
        min: ODOMETER_MIN,
        max: ODOMETER_MAX,
        decimals: 0,
        label: "Odometer reading",
        path: "odometerKm",
      },
      ctx,
    );
    checkNumeric(
      v.engineHours ?? "",
      { min: HOURS_MIN, max: HOURS_MAX, decimals: 1, label: "Engine hours", path: "engineHours" },
      ctx,
    );
  });

export type CreateServiceRecordFormValues = z.infer<typeof CreateServiceRecordFormSchema>;

// ---------------------------------------------------------------------
// Update form schema — PATCH. Every mutable field optional (diff-PATCH).
// `vehicleId` is NOT in the shape — immutable (the API's PATCH .strict()
// rejects it). `serviceScheduleId` / `expenseLogId` are mutable (link / unlink
// after the fact); "" → wire null (the clear signal).
// ---------------------------------------------------------------------

export const UpdateServiceRecordFormSchema = z
  .object({
    serviceScheduleId: z.string().optional(),
    expenseLogId: z.string().optional(),
    performedAt: OptionalDateString,
    odometerKm: z.string().optional(),
    engineHours: z.string().optional(),
    notes: Notes,
  })
  .superRefine((v, ctx) => {
    checkNumeric(
      v.odometerKm ?? "",
      {
        min: ODOMETER_MIN,
        max: ODOMETER_MAX,
        decimals: 0,
        label: "Odometer reading",
        path: "odometerKm",
      },
      ctx,
    );
    checkNumeric(
      v.engineHours ?? "",
      { min: HOURS_MIN, max: HOURS_MAX, decimals: 1, label: "Engine hours", path: "engineHours" },
      ctx,
    );
  });

export type UpdateServiceRecordFormValues = z.infer<typeof UpdateServiceRecordFormSchema>;

// Convert an operator-typed decimal-hours engine-reading to the integer tenths
// the wire stores. Re-exported `hoursToTenths` (the action layer uses it; the
// odometer reading needs no conversion — it is already integer km).
export { hoursToTenths };
