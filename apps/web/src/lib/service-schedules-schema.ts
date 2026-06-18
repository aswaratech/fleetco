import { z } from "zod";

import { formatHours, formatKm, hoursToTenths, tenthsToHoursInput } from "./units";

// Web-side form schema + display/conversion helpers for the ServiceSchedule
// aggregate (ADR-0037 / Program B, B5). Mirrors the API's authoritative schemas
// (apps/api/src/modules/maintenance/service-schedules.schemas.ts) at the field
// level. The API is authoritative; these give the operator immediate inline
// feedback before a round-trip.
//
// Duplication-budget rationale matches geofences-schema.ts / fuel-logs-schema.ts:
// a shared workspace package is deferred; the API rejects anything sent
// incorrectly, so client drift is a UX cost, not a correctness one.
//
// THE INTERVAL REPRESENTATION (ADR-0037 c2) — the load-bearing detail this
// module owns: a schedule's `intervalValue` is one integer in the dimension's
// MINOR UNITS, fixed by `intervalType`:
//   - DISTANCE_KM   → kilometres (integer)                e.g. 5000  → 5000
//   - CALENDAR_DAYS → days (integer)                      e.g. 90    → 90
//   - ENGINE_HOURS  → TENTHS of an hour (never a float)   e.g. 250 h → 2500
// The operator types a human number (km / decimal hours / days); the form keeps
// every field a string and the action layer converts it to the wire integer via
// `intervalValueToMinorUnits` (hours → tenths via the shipped `hoursToTenths`,
// km/days a plain integer). The inverse `intervalValueToInput` pre-fills the
// edit form. Same integer-minor-units discipline the fuel-logs slice applies to
// litres and the engine-hours slice applies to the hour-meter — display divides,
// cross-field math stays in integers.
//
// The meter-consistency rule (an ENGINE_HOURS schedule needs an hour-metered
// vehicle, ADR-0037 c3) needs the vehicle's meterType and so cannot live in this
// pure schema — the create/edit form does a lightweight client-side guard
// against the selected vehicle, and the API 400 is mapped to the intervalType
// input in actions.ts. The API stays authoritative.

// ---------------------------------------------------------------------
// Enums — mirror the Prisma ServiceIntervalType / ServiceScheduleStatus enums
// and the API's INTERVAL_TYPES / SCHEDULE_STATUSES lists. Single source of
// truth for the web side (the row type module re-exports the names).
// ---------------------------------------------------------------------

export const SERVICE_INTERVAL_TYPES = ["DISTANCE_KM", "ENGINE_HOURS", "CALENDAR_DAYS"] as const;
export type ServiceIntervalTypeName = (typeof SERVICE_INTERVAL_TYPES)[number];

export const SERVICE_INTERVAL_TYPE_OPTIONS = [
  { value: "DISTANCE_KM", label: "Distance (km)" },
  { value: "ENGINE_HOURS", label: "Engine hours" },
  { value: "CALENDAR_DAYS", label: "Calendar (days)" },
] as const;

export const SERVICE_INTERVAL_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  SERVICE_INTERVAL_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
);

export const SERVICE_SCHEDULE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ServiceScheduleStatusName = (typeof SERVICE_SCHEDULE_STATUSES)[number];

export const SERVICE_SCHEDULE_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
] as const;

export const SERVICE_SCHEDULE_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  SERVICE_SCHEDULE_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);

// ---------------------------------------------------------------------
// Bounds — mirror the API's INTERVAL_VALUE / METER_READING / NAME /
// DESCRIPTION limits, converted to human units where the unit differs from the
// stored minor unit. The API stores intervalValue 1..100_000_000 minor units;
// for ENGINE_HOURS that minor unit is a tenth, so the human-hours ceiling is
// 10_000_000 h and the floor is 0.1 h. km/days map 1:1.
// ---------------------------------------------------------------------

const NAME_MAX = 256;
const DESCRIPTION_MAX = 2048;
const KM_MIN = 1;
const KM_MAX = 100_000_000;
const DAYS_MIN = 1;
const DAYS_MAX = 100_000_000;
const HOURS_MIN = 0.1;
const HOURS_MAX = 10_000_000;
// Meter anchor readings are non-negative (a brand-new asset reads 0).
const ODOMETER_MIN = 0;
const ODOMETER_MAX = 100_000_000;
const ANCHOR_HOURS_MIN = 0;
const ANCHOR_HOURS_MAX = 10_000_000;

// The unit word shown beside the interval-value input, by type. Drives the form
// field label so the operator knows whether they are typing km, hours, or days.
export function intervalUnitLabel(type: ServiceIntervalTypeName): string {
  switch (type) {
    case "DISTANCE_KM":
      return "km";
    case "ENGINE_HOURS":
      return "hours";
    case "CALENDAR_DAYS":
      return "days";
  }
}

/**
 * Convert an operator-typed interval value (a human number in the type's unit)
 * into the integer minor units the wire stores. km/days are integers (rounded
 * defensively); hours convert to tenths via the shipped `hoursToTenths`
 * (Math.round(h * 10)), the same half-up rule the engine-hours slice uses.
 */
export function intervalValueToMinorUnits(type: ServiceIntervalTypeName, value: number): number {
  switch (type) {
    case "DISTANCE_KM":
    case "CALENDAR_DAYS":
      return Math.round(value);
    case "ENGINE_HOURS":
      return hoursToTenths(value);
  }
}

/**
 * Inverse of `intervalValueToMinorUnits` for the edit form's defaultValues —
 * turn the persisted integer minor units back into the human string the form
 * input accepts (no unit suffix — a numeric input rejects it). Hours go through
 * `tenthsToHoursInput` (2500 → "250.0"); km/days stringify directly.
 */
export function intervalValueToInput(type: ServiceIntervalTypeName, minorUnits: number): string {
  switch (type) {
    case "DISTANCE_KM":
    case "CALENDAR_DAYS":
      return String(minorUnits);
    case "ENGINE_HOURS":
      return tenthsToHoursInput(minorUnits);
  }
}

/**
 * A human-readable interval label, e.g. "Every 5,000 km" / "Every 250.0 h" /
 * "Every 90 days", from the stored type + minor-units value. Reuses the shipped
 * `formatKm` / `formatHours` so the km / hours rendering matches the rest of the
 * app (and the vehicle-detail "Service schedules" section). The single web-side
 * source for the interval label the maintenance pages render.
 */
export function formatIntervalLabel(type: ServiceIntervalTypeName, minorUnits: number): string {
  switch (type) {
    case "DISTANCE_KM":
      return `Every ${formatKm(minorUnits)}`;
    case "ENGINE_HOURS":
      return `Every ${formatHours(minorUnits)}`;
    case "CALENDAR_DAYS":
      return `Every ${minorUnits} ${minorUnits === 1 ? "day" : "days"}`;
  }
}

// ---------------------------------------------------------------------
// Field validators (used inside the object-level superRefine). Each skips the
// empty string (a required field's emptiness is caught by its own .min(1); an
// optional field's emptiness means "not provided" and is valid). Bounds /
// decimal-budget violations attach to the named path so the right input shows
// the message.
// ---------------------------------------------------------------------

interface NumericRule {
  min: number;
  max: number;
  decimals: number; // 0 → integer only
  label: string;
  path: string;
}

function checkNumeric(raw: string, rule: NumericRule, ctx: z.RefinementCtx): void {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return; // emptiness handled elsewhere (required) or valid (optional)
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

// Validate the interval value against the bounds + decimal budget for its type.
// km / days are whole numbers; engine-hours allow one decimal (the 0.1 h meter
// resolution). Exported for the unit test.
export function checkIntervalValue(
  type: ServiceIntervalTypeName,
  raw: string,
  ctx: z.RefinementCtx,
): void {
  switch (type) {
    case "DISTANCE_KM":
      checkNumeric(
        raw,
        { min: KM_MIN, max: KM_MAX, decimals: 0, label: "Interval", path: "intervalValue" },
        ctx,
      );
      return;
    case "CALENDAR_DAYS":
      checkNumeric(
        raw,
        { min: DAYS_MIN, max: DAYS_MAX, decimals: 0, label: "Interval", path: "intervalValue" },
        ctx,
      );
      return;
    case "ENGINE_HOURS":
      checkNumeric(
        raw,
        { min: HOURS_MIN, max: HOURS_MAX, decimals: 1, label: "Interval", path: "intervalValue" },
        ctx,
      );
  }
}

// `<input type="date">` (or the NepaliDatePicker, which emits the same ISO day)
// value: YYYY-MM-DD, or "" when unset. Optional everywhere a schedule anchor is.
const OptionalDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Use the YYYY-MM-DD date format.")
  .optional();

const Name = z.string().trim().min(1, "Name is required.").max(NAME_MAX, "Name is too long.");
const Description = z
  .string()
  .max(DESCRIPTION_MAX, `Description must be at most ${DESCRIPTION_MAX} characters.`)
  .optional();
const IntervalTypeField = z.enum(SERVICE_INTERVAL_TYPES, {
  error: () => `Interval type must be one of: ${SERVICE_INTERVAL_TYPES.join(", ")}.`,
});
const StatusField = z.enum(SERVICE_SCHEDULE_STATUSES, {
  error: () => `Status must be one of: ${SERVICE_SCHEDULE_STATUSES.join(", ")}.`,
});

// ---------------------------------------------------------------------
// Create form schema — POST. Required: vehicleId, name, intervalType,
// intervalValue, status. Optional: description + the last-service anchor
// (lastServiceAt + the dimension's meter reading), seeded by the API from the
// vehicle's current reading when omitted (ADR-0037 c4). Every field is a string
// at the DOM (no transforms beyond trim) so RHF binds it directly; the action
// layer parses + converts. The object superRefine validates the numeric fields
// against the per-type bounds.
// ---------------------------------------------------------------------

export const CreateServiceScheduleFormSchema = z
  .object({
    vehicleId: z.string().min(1, "Pick a vehicle."),
    name: Name,
    description: Description,
    intervalType: IntervalTypeField,
    intervalValue: z.string().min(1, "Interval is required."),
    status: StatusField,
    lastServiceAt: OptionalDateString,
    lastServiceOdometerKm: z.string().optional(),
    lastServiceEngineHours: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    checkIntervalValue(v.intervalType, v.intervalValue, ctx);
    checkNumeric(
      v.lastServiceOdometerKm ?? "",
      {
        min: ODOMETER_MIN,
        max: ODOMETER_MAX,
        decimals: 0,
        label: "Last-service odometer",
        path: "lastServiceOdometerKm",
      },
      ctx,
    );
    checkNumeric(
      v.lastServiceEngineHours ?? "",
      {
        min: ANCHOR_HOURS_MIN,
        max: ANCHOR_HOURS_MAX,
        decimals: 1,
        label: "Last-service hours",
        path: "lastServiceEngineHours",
      },
      ctx,
    );
  });

export type CreateServiceScheduleFormValues = z.infer<typeof CreateServiceScheduleFormSchema>;

// ---------------------------------------------------------------------
// Update form schema — PATCH. Every mutable field optional (diff-PATCH
// semantics). `vehicleId` is NOT in the shape — immutable (the API's PATCH
// .strict() rejects it). `intervalType` IS mutable; the action converts
// `intervalValue` with the effective type. The per-type numeric validation
// re-runs against whatever `intervalType` the diff carries (defaulting to
// DISTANCE_KM when the diff omits it — the action always passes the effective
// type, so this default only governs the in-form message, never the wire value).
// ---------------------------------------------------------------------

export const UpdateServiceScheduleFormSchema = z
  .object({
    name: Name.optional(),
    description: Description,
    intervalType: IntervalTypeField.optional(),
    intervalValue: z.string().optional(),
    status: StatusField.optional(),
    lastServiceAt: OptionalDateString,
    lastServiceOdometerKm: z.string().optional(),
    lastServiceEngineHours: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.intervalValue !== undefined && v.intervalValue.trim().length > 0) {
      checkIntervalValue(v.intervalType ?? "DISTANCE_KM", v.intervalValue, ctx);
    }
    checkNumeric(
      v.lastServiceOdometerKm ?? "",
      {
        min: ODOMETER_MIN,
        max: ODOMETER_MAX,
        decimals: 0,
        label: "Last-service odometer",
        path: "lastServiceOdometerKm",
      },
      ctx,
    );
    checkNumeric(
      v.lastServiceEngineHours ?? "",
      {
        min: ANCHOR_HOURS_MIN,
        max: ANCHOR_HOURS_MAX,
        decimals: 1,
        label: "Last-service hours",
        path: "lastServiceEngineHours",
      },
      ctx,
    );
  });

export type UpdateServiceScheduleFormValues = z.infer<typeof UpdateServiceScheduleFormSchema>;
