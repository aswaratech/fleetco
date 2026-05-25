import { z } from "zod";

// Web-side zod schema for the create-vehicle form. Shape parity with
// apps/api/src/modules/vehicles/vehicles.schemas.ts:CreateVehicleSchema
// — the API performs authoritative validation, but the form's resolver
// uses this schema for client-side inline feedback so the user sees a
// "year is required" error before a network round-trip.
//
// Why duplicate rather than share via a workspace package: at iter 2
// the shared schema would be the only export of a new package, which
// adds tooling overhead disproportionate to one struct. When a second
// surface (e.g., the iter-3 edit form, or a future bulk-import tool)
// needs the same shape, this and the API copy collapse into
// `packages/shared/src/vehicles.ts`. The drift risk meantime is bounded:
// the API rejects anything the client sends incorrectly, so client-side
// schema drift produces a worse UX (server-side validation message
// only) but not a data correctness problem.

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

export const CreateVehicleFormSchema = z.object({
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
  acquiredAt: DateString,
});

export type CreateVehicleFormValues = z.infer<typeof CreateVehicleFormSchema>;

// Display-friendly enum labels. The page-level vehicles list uses the
// same mapping (apps/web/src/app/vehicles/page.tsx); promoting these to
// a shared module is deferred until a third surface needs them.
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
