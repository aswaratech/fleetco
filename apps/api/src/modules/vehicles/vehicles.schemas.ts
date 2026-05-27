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

// Insurance type enum — must mirror InsuranceType in prisma/schema.prisma.
// Added iter 14 alongside the compliance-metadata columns.
const INSURANCE_TYPES = ["THIRD_PARTY", "COMPREHENSIVE"] as const;

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

const InsuranceTypeEnum = z.enum(INSURANCE_TYPES, {
  error: () => `Insurance type must be one of: ${INSURANCE_TYPES.join(", ")}.`,
});

// Compliance-metadata field fragments (iter 14). The three document
// numbers are short identifier strings capped at 64 chars like make /
// model / registrationNumber; the three expiry dates reuse DateInput.
// All are optional on Create and nullable-optional on Update — see the
// schema-level comments. A `.trim().min(1)` guards against a stored
// all-whitespace value while still allowing the field to be omitted.
const ComplianceString = z.string().trim().min(1).max(64);

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
    // Compliance metadata (iter 14) — all optional; a vehicle may be
    // registered before its documents are scanned in. Dates are
    // nullable so a client can explicitly send null (consistent with
    // the Update schema's clear-the-field semantics).
    bluebookNumber: ComplianceString.optional(),
    bluebookExpiresAt: DateInput.nullable().optional(),
    insurer: ComplianceString.optional(),
    insurancePolicyNumber: ComplianceString.optional(),
    insuranceType: InsuranceTypeEnum.optional(),
    insuranceExpiresAt: DateInput.nullable().optional(),
    routePermitNumber: ComplianceString.optional(),
    routePermitExpiresAt: DateInput.nullable().optional(),
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
    // Compliance metadata (iter 14) — nullable-optional on PATCH so the
    // operator can both set a field and explicitly clear it by sending
    // null, matching the retiredAt pattern above.
    bluebookNumber: ComplianceString.nullable().optional(),
    bluebookExpiresAt: DateInput.nullable().optional(),
    insurer: ComplianceString.nullable().optional(),
    insurancePolicyNumber: ComplianceString.nullable().optional(),
    insuranceType: InsuranceTypeEnum.nullable().optional(),
    insuranceExpiresAt: DateInput.nullable().optional(),
    routePermitNumber: ComplianceString.nullable().optional(),
    routePermitExpiresAt: DateInput.nullable().optional(),
  })
  .strict()
  // Reject empty-body PATCH. PATCH with no fields is a useless request
  // that should not silently succeed — surface it as 400 so the client
  // notices.
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateVehicleInput = z.infer<typeof UpdateVehicleSchema>;

// GET /api/v1/vehicles query parameters (iter 4 — list-page polish).
// All four list dimensions (filter, sort, paginate) are validated here
// against one schema so an unknown query key surfaces as 400 via the
// existing ZodValidationPipe, the same way bodies do.
//
// Wire conventions:
//   - `status` and `kind` accept either a single value (`?status=ACTIVE`)
//     or a comma-separated list (`?status=ACTIVE,IN_MAINTENANCE`). Both
//     shapes normalize to a deduplicated array of enum values; the
//     service builds a Prisma `in:` filter from it. An empty string
//     (after splitting) is treated as "no filter on this dimension".
//   - `sortBy` is restricted to a whitelist of sortable columns to keep
//     the index footprint visible. The Vehicle model has explicit
//     indexes on `status` and `kind`; `registrationNumber` is unique
//     and therefore indexed; `acquiredAt`/`odometerCurrentKm`/
//     `createdAt` are unindexed today but acceptable for Phase 1 fleet
//     sizes. Allowing an arbitrary column would invite expensive sorts
//     and accidental information disclosure (e.g., `sortBy=createdById`
//     is not useful to the admin and is not in this whitelist).
//   - `sortDir` defaults to `desc` because the most common use is
//     "newest first" — most recent acquisitions or registrations.
//   - `skip` defaults to 0; `take` defaults to DEFAULT_TAKE (20). The
//     service-side MAX_TAKE clamp (200) is the hard ceiling; the schema
//     mirrors the same ceiling so a too-large `take` returns 400 with a
//     clear message rather than being silently clamped.
const SORTABLE_COLUMNS = [
  "registrationNumber",
  "odometerCurrentKm",
  "acquiredAt",
  "createdAt",
] as const;
export type VehicleSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type VehicleSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from vehicles.service.ts on purpose:
// the service is the runtime authority (the schema can only validate
// what the client sent; it cannot speak for the database). Both
// constants must move together when one changes; the JSDoc above on
// vehicles.service.ts's MAX_TAKE flags the same coupling.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a
// validated, deduplicated array of enum members. Reused by `status`
// and `kind`. An empty result (e.g., `?status=`) is mapped to
// `undefined` so the service can omit the filter rather than asking
// Prisma for `where status in ()` — which would match zero rows.
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  const member = z.enum(values);
  return z
    .string()
    .optional()
    .transform((raw, ctx): T[number][] | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return undefined;
      const seen = new Set<T[number]>();
      for (const part of parts) {
        const parsed = member.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({
            code: "custom",
            message: `Must be one of: ${values.join(", ")}.`,
          });
          return z.NEVER;
        }
        seen.add(parsed.data);
      }
      return Array.from(seen);
    });
}

// Coerce a string-typed query param to a non-negative integer with
// bounds checking. Express's query parser hands us strings; without
// coercion the schema would reject every numeric param. Out-of-range
// values return 400 with a clear message rather than being silently
// clamped — a deliberate `take=10000` clamped to 200 would surprise an
// API consumer who expected to receive what they asked for.
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
        ctx.addIssue({
          code: "custom",
          message: `${fieldLabel} must be ${max} or less.`,
        });
        return z.NEVER;
      }
      return n;
    });
}

export const ListVehiclesQuerySchema = z
  .object({
    status: csvEnum(VEHICLE_STATUSES),
    kind: csvEnum(VEHICLE_KINDS),
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?kine=TRUCK`) surfaces as 400
  // rather than being silently ignored. The kickoff explicitly directs
  // "Reject unknown query keys with 400".
  .strict();

export type ListVehiclesQuery = z.infer<typeof ListVehiclesQuerySchema>;
