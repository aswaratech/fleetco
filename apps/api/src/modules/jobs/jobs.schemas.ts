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

// ---------------------------------------------------------------------
// Write-path schemas (iter 18) — POST and PATCH bodies.
// ---------------------------------------------------------------------
//
// Both schemas are `.strict()` so an unexpected key (e.g. a client
// trying to set `createdById` or `jobNumber` directly, or a typo'd
// field name) surfaces as HTTP 400 with a clear message rather than
// being silently dropped. Two server-controlled fields rely on this:
//
//   - `createdById` is derived from the session and must never be
//     accepted from the wire.
//   - `jobNumber` is generated server-side (JOB-YYYY-NNNNN format,
//     see JobsService.create) and is permanent for a job's lifetime
//     — neither create nor update accepts it.
//
// `customerId` is also NOT updatable: re-assigning a job to a
// different customer is out of scope this iter, and `.strict()`
// rejects it on PATCH (it's required on POST).

// Description bounds. The Prisma column is `String` (unbounded in
// Postgres) but a 2048-character ceiling keeps the surface predictable
// (the iter-17 schema doc-comment names 2048 explicitly). Operators
// wanting a longer scope-of-work get an attachments slice in Phase 2.
const DESCRIPTION_MAX = 2048;

// Notes upper bound. The Prisma column is `String?` (unbounded); the
// iter-17 schema doc-comment names 4096. Same rationale as
// description — predictable upper bound, attachments in Phase 2.
const NOTES_MAX = 4096;

const Description = z
  .string()
  .trim()
  .min(1, "Description is required.")
  .max(DESCRIPTION_MAX, `Description must be at most ${DESCRIPTION_MAX} characters.`);

const Notes = z.string().max(NOTES_MAX, `Notes must be at most ${NOTES_MAX} characters.`);

const JobStatusEnum = z.enum(JOB_STATUSES, {
  error: () => `Status must be one of: ${JOB_STATUSES.join(", ")}.`,
});

// Date fields use `z.coerce.date()` so a web form's YYYY-MM-DD string
// (or an API client's ISO datetime) is coerced into a Date before the
// service writes it. Invalid input fails the schema with a clear
// message rather than producing an Invalid Date at the database
// boundary. Mirror of the Trips schema's approach to timestamps but
// using `coerce` instead of a separate ISO-string regex — Jobs uses
// date-only fields (scheduledStartDate is "what day", not "what
// timestamp"), so the coercion path is the more ergonomic fit. An
// invalid value (e.g., "not-a-date") fails parse with the configured
// error message.
const JobDate = z.coerce.date({
  error: () => "Must be a valid date (YYYY-MM-DD or ISO 8601).",
});

// Shape used by the cross-field validator. Exported so the service
// can re-run the same validation against the merged shape after a
// PATCH (mirror of the Trips approach with validateTripCrossFields).
export interface JobCrossFieldShape {
  scheduledStartDate?: Date | null | undefined;
  scheduledEndDate?: Date | null | undefined;
  actualStartDate?: Date | null | undefined;
  actualEndDate?: Date | null | undefined;
}

/**
 * Validate the Jobs cross-field rules against a merged shape. Returns
 * a list of human-readable error messages; an empty array means valid.
 *
 * Rules (iter-18 kickoff):
 *   - When both `scheduledStartDate` and `scheduledEndDate` are
 *     present, `scheduledEndDate >= scheduledStartDate`.
 *   - When both `actualStartDate` and `actualEndDate` are present,
 *     `actualEndDate >= actualStartDate`.
 *
 * No constraint when either end is null/undefined — a job that has
 * been scheduled with only a start (no firm end yet) is legitimate,
 * as is a job currently in progress (actual start set, actual end
 * still null). The schema-level superRefine calls this on the full
 * create body; the service can call it again against a merged shape
 * during update for defense-in-depth.
 */
export function validateJobCrossFields(shape: JobCrossFieldShape): string[] {
  const errors: string[] = [];
  const { scheduledStartDate, scheduledEndDate, actualStartDate, actualEndDate } = shape;

  if (scheduledStartDate && scheduledEndDate) {
    const start = scheduledStartDate.getTime();
    const end = scheduledEndDate.getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
      errors.push("scheduledEndDate must be greater than or equal to scheduledStartDate.");
    }
  }
  if (actualStartDate && actualEndDate) {
    const start = actualStartDate.getTime();
    const end = actualEndDate.getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
      errors.push("actualEndDate must be greater than or equal to actualStartDate.");
    }
  }
  return errors;
}

// POST /api/v1/jobs body schema. Required: customerId, description.
// Optional: status (defaults to PLANNED at the service), the four
// date fields (nullable + optional), and notes (nullable + optional).
//
// `jobNumber` is intentionally NOT in this schema — it's generated
// server-side from the JOB-YYYY-NNNNN format and `.strict()` rejects
// any client attempt to set it. `createdById` is excluded for the
// same reason; the controller pulls it from the session.
export const CreateJobSchema = z
  .object({
    customerId: z.string().min(1, "customerId is required."),
    description: Description,
    status: JobStatusEnum.optional(),
    scheduledStartDate: JobDate.nullable().optional(),
    scheduledEndDate: JobDate.nullable().optional(),
    actualStartDate: JobDate.nullable().optional(),
    actualEndDate: JobDate.nullable().optional(),
    notes: Notes.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const message of validateJobCrossFields({
      scheduledStartDate: value.scheduledStartDate ?? null,
      scheduledEndDate: value.scheduledEndDate ?? null,
      actualStartDate: value.actualStartDate ?? null,
      actualEndDate: value.actualEndDate ?? null,
    })) {
      ctx.addIssue({ code: "custom", message });
    }
  });

export type CreateJobInput = z.infer<typeof CreateJobSchema>;

// PATCH /api/v1/jobs/:id body schema. Every mutable field is optional
// (diff-PATCH semantics, as in CustomersService.update and
// DriversService.update). Two server-controlled / immutable fields
// are NOT in the shape and so `.strict()` rejects any attempt to set
// them:
//
//   - `jobNumber` — permanent for a job's lifetime (iter-18 kickoff:
//     "a job's number is permanent").
//   - `customerId` — reassigning a job to a different customer is
//     out of scope this iter (iter-18 kickoff: "reassigning a job to
//     a different customer is out of scope").
//
// The cross-field refine runs on the partial body alone; for the
// merged shape the service re-runs validateJobCrossFields after
// folding the patch into the existing row — same defense-in-depth
// pattern Trips uses for its merged-shape validation.
export const UpdateJobSchema = z
  .object({
    description: Description,
    status: JobStatusEnum,
    scheduledStartDate: JobDate.nullable(),
    scheduledEndDate: JobDate.nullable(),
    actualStartDate: JobDate.nullable(),
    actualEndDate: JobDate.nullable(),
    notes: Notes.nullable(),
  })
  .strict()
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  })
  .superRefine((value, ctx) => {
    for (const message of validateJobCrossFields({
      scheduledStartDate: value.scheduledStartDate,
      scheduledEndDate: value.scheduledEndDate,
      actualStartDate: value.actualStartDate,
      actualEndDate: value.actualEndDate,
    })) {
      ctx.addIssue({ code: "custom", message });
    }
  });

export type UpdateJobInput = z.infer<typeof UpdateJobSchema>;
