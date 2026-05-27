import { z } from "zod";

// Zod schemas for the Jobs slice — iter 17 ships the read path
// (ListJobsQuerySchema). Iter 18 will add the write path
// (CreateJobSchema, UpdateJobSchema) including the JOB-YYYY-NNNNN
// generator at the service layer; the wire shape for the create
// surface is intentionally left for that iter so the read-path PR
// reviewers see the read contract in isolation.
//
// Mirrors apps/api/src/modules/trips/trips.schemas.ts (iter 8) in
// shape and convention — the iter-17 kickoff calls out this file as
// the symmetric mirror of trips.schemas.ts and the iter-15 customer
// schemas. Enum lists duplicated from Prisma enums (so this file
// does not pull the Prisma runtime), `.strict()` on every object so
// a typo'd query key surfaces as HTTP 400, comma-separated multi-
// value enum filters via `csvEnum`, and an explicit pagination
// ceiling mirrored from the service-side MAX_TAKE constant.

// JobStatus enum — must mirror JobStatus in prisma/schema.prisma.
// Order matches the Prisma enum so an audit grep finds both lists side
// by side; the order has no runtime significance.
const JOB_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;

// GET /api/v1/jobs query parameters (iter 17 — read path).
// Filter / sort / pagination contract mirrors the Trips and Customers
// list endpoints; the web client's URL-searchParams convention is
// shared across all list surfaces so the same paginator /
// sortable-header / filter-toolbar idioms transfer without surprises.
//
// Wire conventions:
//   - `status` accepts either a single value (`?status=PLANNED`) or a
//     comma-separated list (`?status=PLANNED,IN_PROGRESS`). Normalizes
//     to a deduplicated array; the service builds a Prisma `in:`
//     filter from it. An empty string after splitting is treated as
//     "no filter". Same shape as Trips.
//   - `customerId` accepts a single string. We do NOT parse it as a
//     cuid here: the iter-8 / iter-15 precedent is "accept any string
//     and let the service no-op" — an unknown id will simply produce
//     an empty result set, which is the right shape for a "jobs for
//     this customer" UI that hits a deleted-customer bookmark.
//     Tightening to a cuid format would require an ADR per CLAUDE.md.
//   - `sortBy` is restricted to a whitelist of sortable columns
//     (createdAt / jobNumber / scheduledStartDate). The iter-17
//     ticket spells this out explicitly. Allowing arbitrary columns
//     would invite expensive sorts and accidental information
//     disclosure (`sortBy=description` would expose ordering
//     information about free-form operator text — the same defense
//     the Trips schema documents for `sortBy=notes`).
//   - `sortDir` defaults to `desc` because "most recent first" is the
//     common case for both `createdAt` and `scheduledStartDate`.
//     Consistency with the Trips / Customers / Drivers / Vehicles
//     surfaces wins over per-column defaults.
//   - `skip` defaults to 0; `take` defaults to 20. The schema's `take`
//     ceiling mirrors the service's MAX_TAKE so an over-large `take`
//     surfaces as HTTP 400 with a clear message rather than being
//     silently clamped.
const SORTABLE_COLUMNS = ["createdAt", "jobNumber", "scheduledStartDate"] as const;
export type JobSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type JobSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from jobs.service.ts on purpose: the
// service is the runtime authority (the schema can only validate what
// the client sent; it cannot speak for the database). Both constants
// must move together when one changes; the same coupling
// trips.schemas.ts documents.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a
// validated, deduplicated array of enum members. Reused by `status`.
// An empty result (e.g., `?status=`) is mapped to `undefined` so the
// service can omit the filter rather than asking Prisma for
// `where status in ()` — which would match zero rows.
//
// Identical in shape to the Trips / Drivers / Vehicles / Customers
// versions. Promoting to a shared helper was deferred at iter 15 (the
// fourth aggregate); the iter-17 kickoff scopes this PR to the read
// path so the lift across five places at once is a separate refactor.
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
// bounds checking. Same shape as the Trips schema helper; out-of-range
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

// `customerId` filter: accept any non-empty string. The service builds
// a Prisma `where customerId = ?` filter; a non-existent id naturally
// returns the empty result set, which is the right UX for a "jobs for
// this customer" URL that survives a deleted customer (although the
// new iter-17 Customer-delete-blocker now prevents that case — the
// permissive accept here keeps the surface consistent with the Trips
// vehicleId / driverId filters and lets the controller stay
// declarative). An empty string (e.g., from `?customerId=`) is
// normalized to undefined so the service omits the filter rather than
// asking Prisma for `where customerId = ''`.
const IdFilter = z
  .string()
  .optional()
  .transform((raw) => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });

export const ListJobsQuerySchema = z
  .object({
    status: csvEnum(JOB_STATUSES),
    customerId: IdFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?statuss=PLANNED`) surfaces as
  // 400 rather than being silently ignored. Matches the Trips and
  // Customers contracts.
  .strict();

export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

// Iter 18 (Jobs write path) will add CreateJobSchema / UpdateJobSchema
// here, plus a JOB-YYYY-NNNNN generator at the service layer and the
// `field: "jobNumber"` body shape on P2002 (mirror of Customers'
// PAN-conflict pattern from iter 16). The slot is intentionally left
// blank in iter 17 so the read-path PR stays scoped.
// TODO(iter 18): CreateJobSchema, UpdateJobSchema.
