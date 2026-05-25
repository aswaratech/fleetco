import { z } from "zod";

// Zod schemas for the Vehicles write path (iter 2). These mirror the
// Prisma model defined in apps/api/prisma/schema.prisma; the schema
// itself does not change in iter 2 (kickoff rule). When a field is added
// to Vehicle in a future slice, this file changes alongside the model.
//
// Why zod here rather than NestJS's @nestjs/class-validator: zod is
// already a top-level dependency (apps/api/package.json) and produces
// the same parsed type from the schema, so the controller signature and
// the validation rule co-locate in one place. The ZodValidationPipe in
// this module converts ZodErrors to HTTP 400 with a clear message.
//
// Enum lists are duplicated from the Prisma enums on purpose: keeping
// the validation values inline with Prisma's generated unions would
// require pulling Prisma's runtime into the schema definition, which
// noisily couples a small validation file to the data plane. The cost
// is that adding a new enum value requires a touch in two places; the
// guard is that a stale enum here only loosens validation, never
// corrupts data — the Prisma layer rejects unknown enum values at write
// time and surfaces a clear error.

// Vehicle kind enum — must mirror VehicleKind in prisma/schema.prisma.
const VEHICLE_KINDS = ["TRUCK", "TIPPER", "EXCAVATOR", "LOADER", "GRADER", "OTHER"] as const;

// Vehicle status enum — must mirror VehicleStatus in prisma/schema.prisma.
const VEHICLE_STATUSES = ["ACTIVE", "IN_MAINTENANCE", "RETIRED", "SOLD"] as const;

// Year window. Lower bound: 1980 (older fleet pieces are rare in Nepal;
// a typo entering 1929 should be rejected). Upper bound: current year +1
// to allow registering a new vehicle whose paperwork lists next year's
// model. Both bounds are deliberately wide; the goal is to reject
// obvious typos, not to enforce a business policy on year ranges.
const YEAR_MIN = 1980;
const YEAR_MAX = new Date().getUTCFullYear() + 1;

// Odometer cap. 10 million km is well past the lifetime of any
// realistic heavy vehicle; a higher value is almost certainly an input
// error. Lower bound is 0 (negative odometers are nonsensical).
const ODOMETER_MAX_KM = 10_000_000;

// Registration number is a Nepali commercial plate. Loose validation in
// Phase 1 per the schema's triple-slash comment; tightened in a later
// slice once we have more sample data. We require non-empty and trim.
const RegistrationNumber = z
  .string()
  .trim()
  .min(1, "Registration number is required.")
  .max(64, "Registration number is too long.");

// Date inputs from JSON come in as strings (no native Date in JSON).
// z.coerce.date() accepts ISO-8601 strings and Date instances, rejects
// malformed input with a clear message. Used for acquiredAt and
// (optionally on PATCH) retiredAt.
const DateInput = z.coerce.date({
  // Replaces zod's default error so the user sees what to do.
  error: (issue) =>
    issue.code === "invalid_type" || issue.input === undefined
      ? "Date is required."
      : "Invalid date. Use an ISO-8601 date (YYYY-MM-DD).",
});

const Year = z
  .number()
  .int("Year must be an integer.")
  .min(YEAR_MIN, `Year must be ${YEAR_MIN} or later.`)
  .max(YEAR_MAX, `Year must be ${YEAR_MAX} or earlier.`);

const OdometerKm = z
  .number()
  .int("Odometer must be an integer kilometer value.")
  .min(0, "Odometer cannot be negative.")
  .max(ODOMETER_MAX_KM, `Odometer cannot exceed ${ODOMETER_MAX_KM.toLocaleString("en")} km.`);

const VehicleKindEnum = z.enum(VEHICLE_KINDS, {
  error: () => `Kind must be one of: ${VEHICLE_KINDS.join(", ")}.`,
});

const VehicleStatusEnum = z.enum(VEHICLE_STATUSES, {
  error: () => `Status must be one of: ${VEHICLE_STATUSES.join(", ")}.`,
});

// POST /api/v1/vehicles request body. Mirrors the iter-2 kickoff field
// list. createdById is NOT accepted from the client — the controller
// pulls it from request.session.user.id. odometerCurrentKm defaults to
// odometerStartKm (handled in the service to avoid encoding the
// dependency twice).
export const CreateVehicleSchema = z
  .object({
    registrationNumber: RegistrationNumber,
    kind: VehicleKindEnum,
    make: z.string().trim().min(1, "Make is required.").max(64),
    model: z.string().trim().min(1, "Model is required.").max(64),
    year: Year,
    status: VehicleStatusEnum.optional(),
    odometerStartKm: OdometerKm.optional(),
    odometerCurrentKm: OdometerKm.optional(),
    acquiredAt: DateInput,
  })
  // Strip any extra keys silently; we do not want a stray field
  // (e.g. createdById from a misbehaving client) to ever reach Prisma.
  .strict();

export type CreateVehicleInput = z.infer<typeof CreateVehicleSchema>;

// PATCH /api/v1/vehicles/:id — partial update. Every mutable field is
// optional; id and createdById are NOT present in the schema (the
// controller treats unknown keys as 400 via .strict()). retiredAt is
// allowed here (not on Create) because it represents a transition out
// of the fleet; the service applies the auto-set-when-status-transitions
// rule from the kickoff.
export const UpdateVehicleSchema = z
  .object({
    registrationNumber: RegistrationNumber.optional(),
    kind: VehicleKindEnum.optional(),
    make: z.string().trim().min(1).max(64).optional(),
    model: z.string().trim().min(1).max(64).optional(),
    year: Year.optional(),
    status: VehicleStatusEnum.optional(),
    odometerStartKm: OdometerKm.optional(),
    odometerCurrentKm: OdometerKm.optional(),
    acquiredAt: DateInput.optional(),
    retiredAt: DateInput.nullable().optional(),
  })
  .strict()
  // Reject empty-body PATCH. PATCH with no fields is a useless request
  // that should not silently succeed — surface it as 400 so the client
  // notices.
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateVehicleInput = z.infer<typeof UpdateVehicleSchema>;
