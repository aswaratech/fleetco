import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";

// JobsService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. Same pattern
// the Trips / Customers / Drivers / Vehicles controllers use for
// their services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { JobsService, LIST_TAKE_DEFAULT, type JobDetail, type JobListItem } from "./jobs.service";
import {
  ListJobsQuerySchema,
  type JobSortColumn,
  type JobSortDir,
  type ListJobsQuery,
} from "./jobs.schemas";

// Wire response shape for GET /api/v1/jobs. Mirror of TripsListResponse
// (apps/api/src/modules/trips/trips.controller.ts iter 8) and the
// equivalent Drivers / Vehicles / Customers list responses. The
// echoed-back `skip` / `take` / `sortBy` / `sortDir` let the web
// client render its paginator and sortable-header without re-deriving
// the effective values from URL params — same convention every list
// surface uses so the web paginator component is portable.
export interface JobsListResponse {
  items: JobListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: JobSortColumn;
  sortDir: JobSortDir;
}

// Route prefix: `api/v1/jobs`. Same versioning convention as the
// Trips / Drivers / Vehicles / Customers controllers (controller-level
// prefix rather than a global one — see those controllers'
// equivalent comments).
//
// Per ADR-0021 §6 every route on this controller is auth-guarded. The
// guard is applied at the controller level so a future route added to
// this class inherits the gate by default — opt-out would require an
// explicit decorator, which is the right direction for an admin-only
// surface in Phase 1.
//
// Iter 17 ships the read path only (GET list + GET :id); iter 18 will
// layer the write path (POST create / PATCH update / DELETE remove)
// the same way Trips iter 8 → iter 9 and Customers iter 15 → iter 16
// staged. The TODO at the bottom marks the slot.
@Controller("api/v1/jobs")
@UseGuards(AuthGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /**
   * List jobs with filter / sort / pagination. ZodValidationPipe runs
   * `ListJobsQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `status` from a comma-separated string into a
   *     deduplicated JobStatus array
   *   - parses `skip` / `take` from strings into integers and enforces
   *     the same 1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *     (createdAt / jobNumber / scheduledStartDate)
   *
   * Defaults applied here (when the validated query omits the field)
   * mirror the service's defaults so the response's echoed `sortBy` /
   * `sortDir` / `skip` / `take` are always the values that actually
   * ran the query. Same pattern as TripsController.list.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListJobsQuerySchema)) query: ListJobsQuery,
  ): Promise<JobsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: JobSortColumn = query.sortBy ?? "createdAt";
    const sortDir: JobSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.jobs.list({
      skip,
      take,
      status: query.status,
      customerId: query.customerId,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one job by id with the related Customer object nested for
   * the detail page. JobsService.getById throws NotFoundException
   * (mapped by Nest's default exception filter to HTTP 404 per the
   * api-error-mapping runbook) when the row is missing; the
   * controller stays declarative — same shape as
   * CustomersController.getById.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<JobDetail> {
    return this.jobs.getById(id);
  }

  // TODO(iter 18): @Post() create (HTTP 201) — pulls createdById from
  // request.session.user.id, surfaces P2002 on the generated
  // jobNumber as 409 with `field: "jobNumber"` (mirror of Customers
  // PAN-conflict iter 16), surfaces P2003 on customerId as 400
  // naming `customer` (mirror of Trips P2003 naming `vehicle` /
  // `driver`). @Patch(":id") update; @Delete(":id") remove (204).
}
