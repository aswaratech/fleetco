import { z } from "zod";

// Zod schemas for the Drivers slice. Iter 6 ships the read path only,
// so today this file exports only `ListDriversQuerySchema`. The
// `CreateDriverSchema` and `UpdateDriverSchema` shapes land in iter 7
// alongside the write path; their absence here is intentional rather
// than an oversight.
//
// Mirrors apps/api/src/modules/vehicles/vehicles.schemas.ts in shape
// and convention: enum lists duplicated from Prisma enums (so the
// validation file does not pull the Prisma runtime), `.strict()` to
// reject unknown query keys with HTTP 400, comma-separated multi-value
// enum filters via `csvEnum`, and an explicit pagination ceiling
// mirrored from the service-side MAX_TAKE constant.

// LicenseClass enum — must mirror LicenseClass in prisma/schema.prisma.
// Order matches the Prisma enum so an audit grep finds both lists side
// by side; the order has no runtime significance.
const LICENSE_CLASSES = ["LMV", "HMV", "HTV", "HPMV"] as const;

// DriverStatus enum — must mirror DriverStatus in prisma/schema.prisma.
const DRIVER_STATUSES = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"] as const;

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
