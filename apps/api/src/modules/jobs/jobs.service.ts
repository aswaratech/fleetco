import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, JobStatus } from "@prisma/client";

import type { JobSortColumn, JobSortDir } from "./jobs.schemas";

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

  // TODO(iter 18): create(input, createdById) with JOB-YYYY-NNNNN
  // generator; update(id, input); remove(id). The P2002 path on the
  // generated jobNumber surfaces as ConflictException with the body
  // shape `{ statusCode: 409, message: "Job number already in use.",
  // field: "jobNumber" }` — mirror of the Customers PAN-conflict
  // shape (apps/api/src/modules/customers/customers.service.ts in
  // iter 16). The P2003 path on customerId surfaces as
  // BadRequestException naming `customer` — mirror of the Trips P2003
  // path naming `vehicle` / `driver`.
}
