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

const YEAR_MIN = 1980;
const YEAR_MAX = new Date().getUTCFullYear() + 1;
const ODOMETER_MAX_KM = 10_000_000;

// Date inputs from <input type="date"> render as YYYY-MM-DD strings.
// We accept that form and let the API coerce. An empty string from a
// blank input becomes a required-field error.
const DateString = z
  .string()
  .min(1, "Date is required.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.");

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
  acquiredAt: DateString,
});

export type VehicleFormValues = z.infer<typeof VehicleFormSchema>;

// Create form: omit odometerCurrentKm (the API defaults it to
// odometerStartKm when absent — see VehiclesService.create — and we
// keep the form one field shorter for the common acquisition case).
export const CreateVehicleFormSchema = VehicleFormSchema.omit({
  odometerCurrentKm: true,
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
