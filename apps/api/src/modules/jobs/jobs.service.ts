import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type JobStatus } from "@prisma/client";

import type { CreateJobInput, JobSortColumn, JobSortDir, UpdateJobInput } from "./jobs.schemas";
import { validateJobCrossFields } from "./jobs.schemas";

// Re-export the schema-inferred input types so call sites (notably the
// controller and tests) can pull them from this module — the same
// convention TripsService and CustomersService follow.
export type { CreateJobInput, UpdateJobInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it. Same eslint
// override as the Vehicles / Drivers / Trips / Customers services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// Pagination defaults and bounds. Same `LIST_TAKE_` prefix as the
// Trips / Customers / Drivers services (the iter-6 kickoff named the
// convention explicitly and every subsequent slice has matched it).
// The take cap (200) matches the precedent; the minimum take (1)
// prevents the degenerate count-only request through this endpoint.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Slim projection used by the list endpoint. The list page renders the
// job number, the customer name (via nested include), the status
// badge, and the scheduledStartDate; pulling only those fields via a
// nested Prisma `select` is cheaper than eager-loading the full
// Customer object, and keeps the wire payload small as the book grows.
// The detail endpoint uses the broader `findById` shape with the full
// nested Customer object so the detail page can render every field
// and deep-link back to /customers/<id>.
//
// The Prisma `select` literal below is the runtime authority for what
// the list endpoint returns; the controller's JobListItem type
// (re-exported from this file) shapes the wire response from this
// same select. When the two diverge, TypeScript catches the drift at
// the call site rather than silently dropping fields.
const LIST_SELECT = {
  id: true,
  jobNumber: true,
  customerId: true,
  description: true,
  status: true,
  scheduledStartDate: true,
  scheduledEndDate: true,
  actualStartDate: true,
  actualEndDate: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  customer: {
    select: {
      id: true,
      name: true,
    },
  },
} satisfies Prisma.JobSelect;

// The list item shape — derived from LIST_SELECT via Prisma's
// validator helper. Exported so the controller's response type and
// the tests can share the precise shape.
export type JobListItem = Prisma.JobGetPayload<{ select: typeof LIST_SELECT }>;

// The detail shape — full Job + full nested Customer. The Customer
// relation is required on every Job (the schema's FK is NOT NULL),
// so the include never produces null for it. Iter 19 (or whenever
// Trips gains its `jobId` FK) will add a `trips` back-include here
// so the detail page can render the per-job trip list without an
// extra round-trip.
const DETAIL_INCLUDE = {
  customer: true,
} satisfies Prisma.JobInclude;

export type JobDetail = Prisma.JobGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: JobListItem[];
  total: number;
}

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List jobs with optional filter / sort / pagination. The list
   * endpoint returns the slim projection (LIST_SELECT) so the wire
   * payload stays small even as the book grows; the detail endpoint
   * uses findById with the broader DETAIL_INCLUDE shape.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * first by createdAt — matches the Trips / Customers / Drivers /
   * Vehicles surfaces and the iter-4 list-page convention. The `id`
   * secondary tiebreaker (when createdAt itself is the primary) or
   * the `createdAt` secondary (when any other column is primary) is
   * preserved so paginated results are deterministic — without it,
   * two rows with identical primary sort values can flip between
   * page loads and either duplicate or skip a row.
   *
   * `scheduledStartDate` is nullable; Prisma's default null-ordering
   * sorts nulls last in asc and first in desc, which is the right
   * shape for "most recently scheduled first" (jobs with no scheduled
   * start date slide to the end of a desc sort, where they make sense
   * as "not yet scheduled").
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListJobsQuerySchema`, but the service is also
   * called from inside other modules' code paths in future slices
   * (e.g., a "jobs for this customer" sidebar on the customer detail
   * page that iter 18 or later may add), and a clamp here ensures the
   * database is never asked for an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    customerId,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: JobStatus[];
    customerId?: string;
    sortBy?: JobSortColumn;
    sortDir?: JobSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count
    // so `total` matches what findMany would return at skip=0/take=∞.
    // Empty arrays should not produce `in: []` (which would match zero
    // rows in Prisma) — the schema's csvEnum normalizes those to
    // `undefined`, but a belt-and-braces check here keeps the service
    // robust against any future direct caller that doesn't go through
    // the schema. customerId is a scalar equality filter; an unknown
    // id naturally produces an empty result set, which is the right
    // UX for "jobs for this customer" URLs that survive a deleted
    // customer (although iter 17's onDelete: Restrict now prevents
    // that case — the permissive accept keeps the surface consistent
    // with the Trips vehicleId / driverId filters).
    const where: Prisma.JobWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(customerId ? { customerId } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-
    // breaker on createdAt (or id, when createdAt itself is the
    // primary) so paginated results are stable across requests.
    const orderBy: Prisma.JobOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.JobOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.JobOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.JobOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.job.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: LIST_SELECT,
      }),
      this.prisma.job.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one job by id with the related Customer eager-loaded for
   * the detail page. The controller wraps a null return into
   * NotFoundException so this method stays usable from other modules
   * without exception handling for the not-found path — same shape
   * the Trips and Customers services use.
   *
   * The eager include is the contract under test: the iter-17 detail
   * page expects the nested customer to be present, and Prisma's
   * required-FK guarantees it is. A refactor that changes the
   * include shape (e.g., dropping `customer` to a slim `select`)
   * would need to update both the service-level test and the
   * controller-level response type in the same commit.
   */
  async findById(id: string): Promise<JobDetail | null> {
    return this.prisma.job.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
  }

  /**
   * Fetch one job by id with the customer eager-loaded, or throw
   * NotFoundException. Convenience wrapper used by the controller's
   * GET /:id handler so the 404 shape lives in the service rather
   * than being duplicated at every controller method. The
   * NotFoundException message echoes the id so an operator who
   * mistyped a URL sees what they asked for. Mirror of
   * CustomersService.getById.
   */
  async getById(id: string): Promise<JobDetail> {
    const job = await this.findById(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  /**
   * Plain Job lookup without the eager Customer relation — exposed
   * for the controller's PATCH route (which needs the existing row
   * to confirm the 404 path but does not need to render the nested
   * customer) and for tests that want to assert the raw row shape.
   * Mirror of TripsService.findByIdRaw.
   */
  async findByIdRaw(id: string) {
    return this.prisma.job.findUnique({ where: { id } });
  }

  /**
   * Create a Job. `createdById` is supplied by the controller from
   * the authenticated session, not by the client. CreateJobSchema's
   * `.strict()` keeps `createdById` (and `jobNumber`, and any other
   * unknown key) off the wire; the service trusts that and uses only
   * fields from `CreateJobInput`.
   *
   * `jobNumber` is generated server-side from the format
   * `JOB-YYYY-NNNNN`:
   *
   *   YYYY = current UTC year. We pick UTC (not local) so a job
   *          created at 23:30 NPT on Dec 31 and one created at 00:30
   *          NPT on Jan 1 don't tie-break to the same `YYYY` value —
   *          UTC is monotonic, and the iter-18 kickoff is silent on
   *          the rollover policy so UTC is the conservative default.
   *
   *   NNNNN = zero-padded 5-digit sequence within that UTC year,
   *           starting at 00001. The next sequence value is computed
   *           by finding the highest existing jobNumber whose prefix
   *           matches the current year and parsing its trailing 5
   *           digits. 5 digits gives 99,999 jobs/year headroom — well
   *           above the Phase-1 fleet's expected ~1,000 jobs/year per
   *           DESIGN.md.
   *
   * Race-handling: two concurrent create() calls can compute the
   * same next sequence value because the find-highest + create
   * sequence is not atomic at the database level. The `@unique`
   * index on jobNumber is the race backstop — the loser of the race
   * sees Prisma P2002 on insert, and we retry up to RETRY_MAX times
   * by re-running the find-highest step. In normal operation the
   * retry never fires; under heavy contention it converges quickly
   * because each retry sees the winner's row and computes the next
   * value past it.
   *
   * TODO(later): if jobNumber-collision retries become hot in
   * production (visible as a spike in retry-counter telemetry), swap
   * the find-highest scheme for a Postgres SEQUENCE backing the
   * jobNumber column. That's a schema/ADR decision and is
   * out-of-scope for iter 18 per the kickoff — the retry approach
   * is the pragmatic Phase-1 choice.
   *
   * P2003 (foreign-key constraint failure on `customerId`) maps to
   * BadRequestException naming the bad FK (mirror of the Trips
   * P2003 mapping that names vehicle/driver). The mapping is HTTP
   * 400 (not 409) because the body itself is the problem — an
   * operator submitting a stale form whose selected customer was
   * deleted between page load and submit gets a clear error about
   * the body shape, not a phantom conflict.
   *
   * P2002 (unique-constraint violation on `jobNumber`) that survives
   * the retry loop maps to ConflictException carrying the message
   * the controller's `remapJobNumberConflict` helper translates into
   * `{ field: "jobNumber" }` body shape (mirror of Customers'
   * PAN-conflict shape from iter 16). In practice the retry should
   * prevent this — but the mapping ships defensively.
   */
  async create(input: CreateJobInput, createdById: string): Promise<JobDetail> {
    const RETRY_MAX = 3;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
      const jobNumber = await this.nextJobNumber();
      const data: Prisma.JobUncheckedCreateInput = {
        jobNumber,
        customerId: input.customerId,
        description: input.description,
        status: input.status ?? "PLANNED",
        scheduledStartDate: input.scheduledStartDate ?? null,
        scheduledEndDate: input.scheduledEndDate ?? null,
        actualStartDate: input.actualStartDate ?? null,
        actualEndDate: input.actualEndDate ?? null,
        notes: input.notes ?? null,
        createdById,
      };

      try {
        return await this.prisma.job.create({ data, include: DETAIL_INCLUDE });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === "P2002") {
            // Unique-constraint violation. The collision is almost
            // certainly on jobNumber (the only other unique column on
            // Job is the implicit id, and we don't supply that). Loop
            // and retry — the next nextJobNumber() call will see the
            // winner's row and compute the next value past it.
            lastError = error;
            continue;
          }
          if (error.code === "P2003") {
            // Foreign-key violation. The two FKs on Job are
            // customerId and createdById; we name customerId in the
            // common case (the operator picked a customer that was
            // deleted between page load and submit) and call out
            // createdById as a "sign in again" hint in the
            // defense-in-depth case.
            const fieldName = String(
              (error.meta as { field_name?: string; constraint?: string } | undefined)
                ?.field_name ??
                (error.meta as { field_name?: string; constraint?: string } | undefined)
                  ?.constraint ??
                "",
            );
            if (fieldName.toLowerCase().includes("customer")) {
              throw new BadRequestException(`Customer "${input.customerId}" does not exist.`);
            }
            if (fieldName.toLowerCase().includes("createdby")) {
              throw new BadRequestException(
                `Authenticated user "${createdById}" no longer exists; sign in again.`,
              );
            }
            // Unknown FK name: surface a generic message naming
            // customerId (the only FK the client controls).
            throw new BadRequestException(`Customer "${input.customerId}" does not exist.`);
          }
        }
        throw error;
      }
    }

    // The retry loop exhausted without a successful create. Surface
    // as ConflictException; the controller translates this into the
    // `{ field: "jobNumber" }` body shape. Should be effectively
    // unreachable — if it ever fires, the next-sequence logic has
    // pathological contention and the TODO(later) sequence-backed
    // generator above becomes the right answer.
    throw new ConflictException(
      `Could not generate a unique jobNumber after ${RETRY_MAX} attempts. ${
        lastError instanceof Error ? lastError.message : ""
      }`.trim(),
    );
  }

  /**
   * Compute the next `JOB-YYYY-NNNNN` value for the current UTC year.
   * Finds the highest existing jobNumber whose prefix matches the
   * current year and increments its trailing sequence. When no jobs
   * exist for the year, starts at 00001.
   *
   * Public-ish (it's `private`-by-convention) — the create() method
   * is the only caller. Exposed as a separate function so the retry
   * loop can re-invoke it without duplicating the prefix/parse logic.
   */
  private async nextJobNumber(): Promise<string> {
    const year = new Date().getUTCFullYear();
    const prefix = `JOB-${year}-`;

    const highest = await this.prisma.job.findFirst({
      where: { jobNumber: { startsWith: prefix } },
      orderBy: { jobNumber: "desc" },
      select: { jobNumber: true },
    });

    let next = 1;
    if (highest) {
      // The stored format is JOB-YYYY-NNNNN. Strip the prefix and
      // parse the trailing digits; a malformed value (somehow) gets
      // treated as zero so we don't crash on bad legacy data.
      const sequencePart = highest.jobNumber.slice(prefix.length);
      const parsed = Number.parseInt(sequencePart, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        next = parsed + 1;
      }
    }

    return `${prefix}${String(next).padStart(5, "0")}`;
  }

  /**
   * Diff-PATCH a Job. Mirrors CustomersService.update in shape:
   *
   *   1. Fetch the existing row (404 if missing, surfaced as
   *      NotFoundException).
   *   2. Build the merged shape and re-run the cross-field validator
   *      against the merged date pairs — Zod's schema-level
   *      superRefine only sees the partial body; a PATCH that sets
   *      `scheduledEndDate` without re-sending `scheduledStartDate`
   *      must still be validated against the row's stored start.
   *   3. Let Prisma do the write. P2025 → NotFoundException (rare;
   *      only happens if a concurrent DELETE landed between step 1
   *      and the update).
   *
   * Returns the job's DETAIL_INCLUDE shape so the controller can
   * respond with the same shape that GET /api/v1/jobs/:id returns.
   *
   * `customerId` and `jobNumber` are not accepted by UpdateJobSchema
   * (`.strict()` + their absence from the shape rejects both). So the
   * update body cannot trigger a P2003 on customerId, and the
   * jobNumber stays permanent.
   */
  async update(id: string, input: UpdateJobInput): Promise<JobDetail> {
    const existing = await this.prisma.job.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    // Build the merged shape: existing row, then the patch keys
    // layered on top. We use `hasOwnProperty` so an explicit `null`
    // in the patch (e.g., clearing scheduledEndDate by setting it to
    // null) is treated as a real value change rather than "field
    // omitted". Same approach TripsService.update uses.
    const has = (key: keyof UpdateJobInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    const merged = {
      scheduledStartDate: has("scheduledStartDate")
        ? (input.scheduledStartDate ?? null)
        : existing.scheduledStartDate,
      scheduledEndDate: has("scheduledEndDate")
        ? (input.scheduledEndDate ?? null)
        : existing.scheduledEndDate,
      actualStartDate: has("actualStartDate")
        ? (input.actualStartDate ?? null)
        : existing.actualStartDate,
      actualEndDate: has("actualEndDate") ? (input.actualEndDate ?? null) : existing.actualEndDate,
    };

    // Cross-field validation against the merged shape. The schema
    // already validated any pair *within* the PATCH body; this
    // re-run catches the case where the PATCH supplies only one
    // half of a pair and the existing row supplies the other.
    const crossFieldErrors = validateJobCrossFields(merged);
    if (crossFieldErrors.length > 0) {
      throw new BadRequestException(crossFieldErrors.join(" "));
    }

    const data: Prisma.JobUpdateInput = {
      ...(has("description") &&
        input.description !== undefined && { description: input.description }),
      ...(has("status") && input.status !== undefined && { status: input.status }),
      ...(has("scheduledStartDate") && { scheduledStartDate: input.scheduledStartDate ?? null }),
      ...(has("scheduledEndDate") && { scheduledEndDate: input.scheduledEndDate ?? null }),
      ...(has("actualStartDate") && { actualStartDate: input.actualStartDate ?? null }),
      ...(has("actualEndDate") && { actualEndDate: input.actualEndDate ?? null }),
      ...(has("notes") && { notes: input.notes ?? null }),
    };

    try {
      return await this.prisma.job.update({
        where: { id },
        data,
        include: DETAIL_INCLUDE,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        // Row vanished between the findUnique and the update — rare
        // but possible if a concurrent DELETE landed in between. Map
        // to NotFoundException so the controller surfaces 404.
        throw new NotFoundException(`Job ${id} not found`);
      }
      throw error;
    }
  }

  /**
   * Hard delete a Job. P2025 (delete targets a non-existent row)
   * maps to NotFoundException.
   *
   * TODO(trip→job FK slice): when Trips reference Jobs by `jobId`
   * (a future slice on the roadmap), this method gains the same
   * P2003 → ConflictException delete-blocker the Customer delete
   * has today — analogous to the iter-17 Customer delete that
   * blocks when a Job FKs into it. No referencing slice exists yet
   * in Phase 1, so the mapping is not needed here today; a P2003
   * on this method would only fire defensively (and there is no
   * such constraint inbound on Job in iter 18).
   *
   * Returns void on success; the controller responds 204 No Content.
   */
  async delete(id: string): Promise<void> {
    try {
      await this.prisma.job.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        throw new NotFoundException(`Job ${id} not found`);
      }
      throw error;
    }
  }
}
