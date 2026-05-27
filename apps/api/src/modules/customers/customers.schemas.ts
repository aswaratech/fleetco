import { z } from "zod";

// Zod schemas for the Customers slice. Iter 15 ships the read path
// (`ListCustomersQuerySchema`); iter 16 will add `CreateCustomerSchema`
// and `UpdateCustomerSchema` for the write path the same way Drivers
// staged iter-6 → iter-7. This file deliberately mirrors
// apps/api/src/modules/drivers/drivers.schemas.ts in shape and
// convention: enum lists duplicated from Prisma enums (so the
// validation file does not pull the Prisma runtime), `.strict()` to
// reject unknown keys with HTTP 400, comma-separated multi-value enum
// filters via `csvEnum`, and an explicit pagination ceiling mirrored
// from the service-side LIST_TAKE_MAX constant.

// CustomerStatus enum — must mirror CustomerStatus in prisma/schema.prisma.
// Order matches the Prisma enum so an audit grep finds both lists side
// by side; the order has no runtime significance. Customers have a
// simpler status set than Drivers/Vehicles — a customer is either
// current business or dormant business.
const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE"] as const;

// GET /api/v1/customers query parameters (iter 15 — read path).
// Filter / sort / pagination contract mirrors the Drivers list
// endpoint; the web client's URL-searchParams convention is shared
// across surfaces so the same paginator / sortable-header /
// filter-toolbar idioms can be reused on the Customers list page.
//
// Wire conventions:
//   - `status` accepts either a single value (`?status=ACTIVE`) or a
//     comma-separated list (`?status=ACTIVE,INACTIVE`). Both normalize
//     to a deduplicated array; the service builds a Prisma `in:`
//     filter from it. An empty string (after splitting) is treated as
//     "no filter".
//   - `sortBy` is restricted to a whitelist of sortable columns. The
//     Customer model has an explicit index on `status` (defined in
//     schema.prisma); `name` and `createdAt` are also acceptable
//     primary sorts for Phase-1 fleet sizes — the same calculus as
//     Drivers. Allowing an arbitrary column would invite expensive
//     sorts and accidental information disclosure (`sortBy=phone`
//     would expose ordering information about Tier 2 PII; same
//     defense the Drivers schema documents).
//   - `sortDir` defaults at the controller to `desc` because "most
//     recent first" is the common case for `createdAt`. The default is
//     consistent across surfaces.
//   - `skip` defaults to 0; `take` defaults to 20. The schema's `take`
//     ceiling mirrors the service's LIST_TAKE_MAX so an over-large
//     `take` surfaces as HTTP 400 with a clear message rather than
//     being silently clamped.
const SORTABLE_COLUMNS = ["name", "createdAt"] as const;
export type CustomerSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type CustomerSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from customers.service.ts on purpose:
// the service is the runtime authority (the schema can only validate
// what the client sent; it cannot speak for the database). Both
// constants must move together when one changes; the JSDoc on
// customers.service.ts's LIST_TAKE_MAX flags the same coupling.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a
// validated, deduplicated array of enum members. Identical in shape to
// the Drivers and Vehicles versions; promoting to a shared helper is
// deferred — this iter is the third aggregate to declare it, which
// crosses the duplication-budget threshold the Drivers schema comment
// flags. The promotion is intentionally deferred to iter 16 (or a
// later dedicated refactor) so iter 15 stays scoped to the read path.
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
// clamped — a deliberate `take=10000` clamped to 200 would surprise
// an API consumer who expected to receive what they asked for. Same
// helper shape as drivers.schemas.ts.
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

export const ListCustomersQuerySchema = z
  .object({
    status: csvEnum(CUSTOMER_STATUSES),
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?staus=ACTIVE`) surfaces as
  // 400 rather than being silently ignored. Matches the Drivers and
  // Vehicles contracts.
  .strict();

export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;
