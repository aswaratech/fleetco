import { z } from "zod";

// Zod schemas for the Drivers slice. Iter 6 shipped the read path
// (`ListDriversQuerySchema`); iter 7 adds the write path:
// `CreateDriverSchema` and `UpdateDriverSchema`. The previous
// "absent in iter 6 by design" comment is no longer applicable —
// both surfaces now live here.
//
// Mirrors apps/api/src/modules/vehicles/vehicles.schemas.ts in shape
// and convention: enum lists duplicated from Prisma enums (so the
// validation file does not pull the Prisma runtime), `.strict()` to
// reject unknown keys (body or query) with HTTP 400, comma-separated
// multi-value enum filters via `csvEnum`, and an explicit pagination
// ceiling mirrored from the service-side MAX_TAKE constant.

// LicenseClass enum — must mirror LicenseClass in prisma/schema.prisma.
// Order matches the Prisma enum so an audit grep finds both lists side
// by side; the order has no runtime significance.
const LICENSE_CLASSES = ["LMV", "HMV", "HTV", "HPMV"] as const;

// DriverStatus enum — must mirror DriverStatus in prisma/schema.prisma.
const DRIVER_STATUSES = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"] as const;

// Reusable field validators for the write path. These mirror the Tier 2
// rules from the Drivers slice's schema comments:
//
//   - fullName / licenseNumber are trimmed and required non-empty
//     (an all-whitespace value collapses to "" after trim and fails).
//     Max lengths are loose (128) to accommodate Nepali transliterated
//     names and rare longer DoTM license formats.
//   - phone is loose per CLAUDE.md "no PII-heavy regex": accept either
//     a `+977-`-prefixed number (the canonical Nepali international
//     form) or a 10-digit local number with optional separators. The
//     pattern intentionally does not validate Nepali NTC/Ncell
//     subscriber prefixes — the operator types what is printed on the
//     paperwork.
//   - dates accept ISO-8601 strings (the common case from JSON bodies)
//     and Date instances via `z.coerce.date()`.

const FullName = z
  .string()
  .trim()
  .min(1, "Full name is required.")
  .max(128, "Full name is too long.");

const LicenseNumber = z
  .string()
  .trim()
  .min(1, "License number is required.")
  .max(64, "License number is too long.");

// Nepal phone: either `+977-<7-to-12 digits, optional dashes/spaces>` or
// a 10-digit local number (with optional dashes/spaces). The regex is
// deliberately loose; tightening it would require an ADR per CLAUDE.md
// because Nepali subscriber prefixes change as the carriers rotate
// number ranges.
const NEPAL_PHONE_REGEX = /^(?:\+977[- ]?[\d][\d\s-]{6,14}|[\d][\d\s-]{8,14})$/;

const Phone = z
  .string()
  .trim()
  .min(1, "Phone is required.")
  .regex(
    NEPAL_PHONE_REGEX,
    "Phone must be a Nepal number (e.g. +977-9800000000 or a 10-digit local number).",
  );

const LicenseClassEnum = z.enum(LICENSE_CLASSES, {
  error: () => `License class must be one of: ${LICENSE_CLASSES.join(", ")}.`,
});

const DriverStatusEnum = z.enum(DRIVER_STATUSES, {
  error: () => `Status must be one of: ${DRIVER_STATUSES.join(", ")}.`,
});

// ISO-8601 date input. Matches the Vehicles convention (z.coerce.date()
// with a friendlier error message). The kickoff calls for explicit ISO
// support; z.coerce.date() accepts ISO strings, numeric timestamps, and
// Date instances, which is the right surface for both web JSON bodies
// and direct service callers.
const DateInput = z.coerce.date({
  error: (issue) =>
    issue.code === "invalid_type" || issue.input === undefined
      ? "Date is required."
      : "Invalid date. Use an ISO-8601 date (YYYY-MM-DD).",
});

// POST /api/v1/drivers request body. The required fields match the
// iter-7 kickoff list (fullName, licenseNumber, licenseClass, phone,
// hiredAt, licenseExpiresAt). `status` defaults at the service layer
// (DriverStatus.ACTIVE); `dateOfBirth` is optional. `createdById` is
// NOT accepted from the client — the controller pulls it from
// `request.session.user.id`. `.strict()` rejects unknown keys with
// HTTP 400 so a stray field (e.g. `terminatedAt` or `createdById` from
// a misbehaving client) never reaches Prisma.
export const CreateDriverSchema = z
  .object({
    fullName: FullName,
    licenseNumber: LicenseNumber,
    licenseClass: LicenseClassEnum,
    phone: Phone,
    dateOfBirth: DateInput.optional(),
    hiredAt: DateInput,
    licenseExpiresAt: DateInput,
    status: DriverStatusEnum.optional(),
  })
  .strict();

export type CreateDriverInput = z.infer<typeof CreateDriverSchema>;

// PATCH /api/v1/drivers/:id — partial update. Mirrors the Vehicles
// pattern: take CreateDriverSchema's shape as `.partial()` and extend
// with `terminatedAt` (which only the update surface exposes — a
// driver is born active, never terminated). The service applies the
// terminated-transition rule on top of whatever the client sends.
// `dateOfBirth` is also nullable here so an operator can clear a
// previously-entered DOB by sending null explicitly.
//
// The `.refine` rejects an empty body. An empty PATCH is a useless
// request that should not silently 200; surfacing as 400 keeps the
// behavior honest. (Vehicles uses the identical refine — see
// vehicles.schemas.ts:UpdateVehicleSchema.)
export const UpdateDriverSchema = CreateDriverSchema.partial()
  .extend({
    terminatedAt: DateInput.nullable().optional(),
    dateOfBirth: DateInput.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateDriverInput = z.infer<typeof UpdateDriverSchema>;

// GET /api/v1/drivers query parameters (iter 6 — read path).
// Filter / sort / pagination contract mirrors the Vehicles list
// endpoint; the web client's URL-searchParams convention is shared
// between the two surfaces so the same paginator / sortable-header /
// filter-toolbar idioms can be reused on the Drivers list page.
//
// Wire conventions:
//   - `status` and `licenseClass` accept either a single value
//     (`?status=ACTIVE`) or a comma-separated list
//     (`?status=ACTIVE,ON_LEAVE`). Both normalize to a deduplicated
//     array; the service builds a Prisma `in:` filter from it. An
//     empty string (after splitting) is treated as "no filter".
//   - `sortBy` is restricted to a whitelist of sortable columns. The
//     Driver model has explicit indexes on `status` and `licenseClass`
//     (defined in schema.prisma); `fullName`, `hiredAt`, and
//     `licenseExpiresAt` are unindexed today but acceptable for Phase 1
//     fleet sizes — the same calculus as Vehicles. Allowing an
//     arbitrary column would invite expensive sorts and accidental
//     information disclosure (`sortBy=phone` would expose ordering
//     information about Tier 2 PII).
//   - `sortDir` defaults to `desc` because "most recent first" is the
//     common case for both `createdAt` and `hiredAt`. For `fullName`
//     and `licenseExpiresAt` a sensible default is more debatable, but
//     consistency with the Vehicles surface wins over per-column
//     defaults.
//   - `skip` defaults to 0; `take` defaults to 20. The schema's `take`
//     ceiling mirrors the service's MAX_TAKE so an over-large `take`
//     surfaces as HTTP 400 with a clear message rather than being
//     silently clamped.
const SORTABLE_COLUMNS = ["fullName", "hiredAt", "licenseExpiresAt", "createdAt"] as const;
export type DriverSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type DriverSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from drivers.service.ts on purpose:
// the service is the runtime authority (the schema can only validate
// what the client sent; it cannot speak for the database). Both
// constants must move together when one changes; the JSDoc on
// drivers.service.ts's LIST_TAKE_MAX flags the same coupling.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a
// validated, deduplicated array of enum members. Reused by `status`
// and `licenseClass`. An empty result (e.g., `?status=`) is mapped to
// `undefined` so the service can omit the filter rather than asking
// Prisma for `where status in ()` — which would match zero rows.
//
// Identical in shape to the Vehicles version; promoting to a shared
// helper is deferred until the third aggregate (Customers) needs it
// (the duplication-budget threshold documented in
// docs/architecture/decisions/ for service-level helpers).
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

export const ListDriversQuerySchema = z
  .object({
    status: csvEnum(DRIVER_STATUSES),
    licenseClass: csvEnum(LICENSE_CLASSES),
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?licenseclas=HTV`) surfaces as
  // 400 rather than being silently ignored. Matches the Vehicles
  // contract.
  .strict();

export type ListDriversQuery = z.infer<typeof ListDriversQuerySchema>;
