import { z } from "zod";

// Web-side zod schemas for the Vehicles forms. Shape parity with
// apps/api/src/modules/vehicles/vehicles.schemas.ts:CreateVehicleSchema
// and :UpdateVehicleSchema — the API performs authoritative validation,
// but the form's resolver uses these schemas for client-side inline
// feedback so the user sees a "year is required" error before a network
// round-trip.
//
// Why duplicate rather than share via a workspace package: at iter 2
// the shared schema would be the only export of a new package, which
// adds tooling overhead disproportionate to one struct. Iter 3 adds the
// update variant alongside it; the duplication budget is reviewed when
// the next aggregate (Drivers) also needs a form schema. The drift risk
// meantime is bounded: the API rejects anything the client sends
// incorrectly, so client-side schema drift produces a worse UX
// (server-side validation message only) but not a data correctness
// problem.

const VEHICLE_KINDS = ["TRUCK", "TIPPER", "EXCAVATOR", "LOADER", "GRADER", "OTHER"] as const;
const VEHICLE_STATUSES = ["ACTIVE", "IN_MAINTENANCE", "RETIRED", "SOLD"] as const;
const INSURANCE_TYPES = ["THIRD_PARTY", "COMPREHENSIVE"] as const;
// Meter type (ADR-0036) — mirrors MeterType in the API's vehicles.schemas.ts.
const METER_TYPES = ["ODOMETER_KM", "ENGINE_HOURS", "BOTH"] as const;

const YEAR_MIN = 1980;
const YEAR_MAX = new Date().getUTCFullYear() + 1;
const ODOMETER_MAX_KM = 10_000_000;
// Engine-hours decimal-hours ceiling: 1,000,000 h = the API's
// ENGINE_HOURS_MAX_TENTHS (10,000,000 tenths) after the hours→tenths conversion.
const ENGINE_HOURS_MAX_HOURS = 1_000_000;

// Date inputs from <input type="date"> render as YYYY-MM-DD strings.
// We accept that form and let the API coerce. An empty string from a
// blank input becomes a required-field error.
const DateString = z
  .string()
  .min(1, "Date is required.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.");

// Optional compliance-metadata field shapes (iter 14). Unlike the
// required fields above, these allow empty (the operator may register a
// vehicle before its documents are scanned in). The action layer omits
// empty values from the wire body so the API never receives "".
//   - OptionalComplianceString: ≤64 chars or empty.
//   - OptionalDateString: YYYY-MM-DD or empty.
const OptionalComplianceString = z.string().trim().max(64, "Too long.").optional();
const OptionalDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Use the YYYY-MM-DD date format.")
  .optional();

// Engine-hours (ADR-0036) entered as a DECIMAL number of hours (e.g. "1234.5"),
// kept as a string in the form so an empty optional field round-trips as "" (no
// 0-coercion). The action layer converts a non-empty value to integer tenths via
// hoursToTenths (units.ts), mirroring the fuel form's litersToMl. At most one
// decimal place — the hour-meter's native 0.1 h resolution; the API
// authoritatively bounds the integer tenths. Empty = "not set" (null on the wire).
const OptionalHoursString = z
  .string()
  .optional()
  .refine((v) => v === undefined || v === "" || /^\d+(\.\d)?$/.test(v), {
    message: "Enter hours as a number with at most one decimal (e.g. 1234.5).",
  })
  .refine((v) => v === undefined || v === "" || Number(v) <= ENGINE_HOURS_MAX_HOURS, {
    message: `Engine hours cannot exceed ${ENGINE_HOURS_MAX_HOURS.toLocaleString("en")}.`,
  });

// Shared field shape used by both Create and Update forms. The Create
// form requires every field (except odometerCurrentKm, which the API
// defaults to odometerStartKm); the Update form derives a partial of
// this shape via `.partial()` and adds `retiredAt` (which is not part
// of the create surface — a vehicle is born active, never retired).
//
// Each field's validator matches the API's authoritative version in
// apps/api/src/modules/vehicles/vehicles.schemas.ts so the client-side
// feedback aligns with the eventual server response. When the API rule
// changes, this file changes in the same commit.
export const VehicleFormSchema = z.object({
  registrationNumber: z
    .string()
    .trim()
    .min(1, "Registration number is required.")
    .max(64, "Registration number is too long."),
  kind: z.enum(VEHICLE_KINDS, {
    error: () => `Kind must be one of: ${VEHICLE_KINDS.join(", ")}.`,
  }),
  make: z.string().trim().min(1, "Make is required.").max(64),
  model: z.string().trim().min(1, "Model is required.").max(64),
  year: z.coerce
    .number({ error: "Year must be a number." })
    .int("Year must be an integer.")
    .min(YEAR_MIN, `Year must be ${YEAR_MIN} or later.`)
    .max(YEAR_MAX, `Year must be ${YEAR_MAX} or earlier.`),
  status: z.enum(VEHICLE_STATUSES, {
    error: () => `Status must be one of: ${VEHICLE_STATUSES.join(", ")}.`,
  }),
  odometerStartKm: z.coerce
    .number({ error: "Odometer must be a number." })
    .int("Odometer must be an integer kilometer value.")
    .min(0, "Odometer cannot be negative.")
    .max(ODOMETER_MAX_KM, `Odometer cannot exceed ${ODOMETER_MAX_KM.toLocaleString("en")} km.`),
  odometerCurrentKm: z.coerce
    .number({ error: "Odometer must be a number." })
    .int("Odometer must be an integer kilometer value.")
    .min(0, "Odometer cannot be negative.")
    .max(ODOMETER_MAX_KM, `Odometer cannot exceed ${ODOMETER_MAX_KM.toLocaleString("en")} km.`),
  // Engine-hours metering (ADR-0036). meterType drives which reading(s) the
  // trip-stop UI prompts for and which lifetime stat the detail page shows; the
  // two hours fields are decimal-hours strings (see OptionalHoursString), shown
  // only when the meter includes hours. Both stay optional — an hour-metered
  // asset may be registered before its SMR is keyed in (the columns are nullable).
  meterType: z.enum(METER_TYPES, {
    error: () => `Meter type must be one of: ${METER_TYPES.join(", ")}.`,
  }),
  engineHoursStart: OptionalHoursString,
  engineHoursCurrent: OptionalHoursString,
  acquiredAt: DateString,
  // Compliance metadata (iter 14) — all optional. Empty values are
  // dropped from the wire body by the action layer; the API stores
  // null. `insuranceType` allows "" for the "not chosen" select option.
  bluebookNumber: OptionalComplianceString,
  bluebookExpiresAt: OptionalDateString,
  insurer: OptionalComplianceString,
  insurancePolicyNumber: OptionalComplianceString,
  insuranceType: z.enum(INSURANCE_TYPES).or(z.literal("")).optional(),
  insuranceExpiresAt: OptionalDateString,
  routePermitNumber: OptionalComplianceString,
  routePermitExpiresAt: OptionalDateString,
});

export type VehicleFormValues = z.infer<typeof VehicleFormSchema>;

// Create form: omit odometerCurrentKm and engineHoursCurrent (the API defaults
// each "current" to its "start" when absent — see VehiclesService.create — and
// we keep the form one field shorter per meter for the common acquisition case).
export const CreateVehicleFormSchema = VehicleFormSchema.omit({
  odometerCurrentKm: true,
  engineHoursCurrent: true,
});

export type CreateVehicleFormValues = z.infer<typeof CreateVehicleFormSchema>;

// Update form: every field optional (PATCH semantics), plus
// `retiredAt` which only the update surface uses. The API mirrors this
// shape in UpdateVehicleSchema (vehicles.schemas.ts) and applies the
// retirement-transition rule server-side: a status change INTO
// RETIRED/SOLD sets retiredAt; a status change OUT of those clears it.
// The web edit form therefore does NOT need to manage retiredAt
// explicitly when the user is just changing status — and in fact must
// NOT, because sending retiredAt alongside an unchanged status would
// override the server-side derived value. The submit pathway computes
// a diff against the initial values and PATCHes only changed fields
// (see DESIGN.md §"Inputs and forms" "Diff-against-initial-values for
// PATCH").
//
// retiredAt accepts either a `Date` (coerced from a date-input string
// or an API ISO timestamp) or `null` (explicit "clear retiredAt"). The
// iter-3 edit form does not yet render a retiredAt input — the rule
// covers the common cases — but the validator is in place so a future
// surface can use it without re-extending the schema.
export const UpdateVehicleFormSchema = VehicleFormSchema.partial().extend({
  retiredAt: z.coerce.date().nullable().optional(),
});

export type UpdateVehicleFormValues = z.infer<typeof UpdateVehicleFormSchema>;

// Display-friendly enum labels. The page-level vehicles list uses the
// same mapping (apps/web/src/app/vehicles/page.tsx) and the detail page
// reuses it too; promoting these to a shared module is deferred until a
// fourth surface needs them.
export const VEHICLE_KIND_OPTIONS: readonly {
  value: (typeof VEHICLE_KINDS)[number];
  label: string;
}[] = [
  { value: "TRUCK", label: "Truck" },
  { value: "TIPPER", label: "Tipper" },
  { value: "EXCAVATOR", label: "Excavator" },
  { value: "LOADER", label: "Loader" },
  { value: "GRADER", label: "Grader" },
  { value: "OTHER", label: "Other" },
];

export const VEHICLE_STATUS_OPTIONS: readonly {
  value: (typeof VEHICLE_STATUSES)[number];
  label: string;
}[] = [
  { value: "ACTIVE", label: "Active" },
  { value: "IN_MAINTENANCE", label: "In maintenance" },
  { value: "RETIRED", label: "Retired" },
  { value: "SOLD", label: "Sold" },
];

export const VEHICLE_KIND_LABELS: Record<string, string> = Object.fromEntries(
  VEHICLE_KIND_OPTIONS.map(({ value, label }) => [value, label]),
);

export const VEHICLE_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  VEHICLE_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);

// Insurance-type options + labels (iter 14). The create / edit form
// selects render an empty "—" option for "not set"; the detail page
// uses the label map for friendly display.
export const INSURANCE_TYPE_OPTIONS: readonly {
  value: (typeof INSURANCE_TYPES)[number];
  label: string;
}[] = [
  { value: "THIRD_PARTY", label: "Third party" },
  { value: "COMPREHENSIVE", label: "Comprehensive" },
];

export const INSURANCE_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  INSURANCE_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
);

// Meter-type options + labels (ADR-0036). The create / edit form renders these
// as a native <select>; the detail page uses the label map for friendly display.
// Labels name the meter in the operator's terms (km vs engine-hours).
export const METER_TYPE_OPTIONS: readonly {
  value: (typeof METER_TYPES)[number];
  label: string;
}[] = [
  { value: "ODOMETER_KM", label: "Odometer (km)" },
  { value: "ENGINE_HOURS", label: "Engine hours" },
  { value: "BOTH", label: "Both (km + hours)" },
];

export const METER_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  METER_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
);

// Does this meter capture engine-hours? Used by the forms to show / hide the
// hours inputs and by the detail page to show the hours stat (ADR-0036 c1).
export function meterIncludesHours(meterType: string): boolean {
  return meterType === "ENGINE_HOURS" || meterType === "BOTH";
}

// Does this meter capture odometer km? (ODOMETER_KM and BOTH.)
export function meterIncludesOdometer(meterType: string): boolean {
  return meterType === "ODOMETER_KM" || meterType === "BOTH";
}
