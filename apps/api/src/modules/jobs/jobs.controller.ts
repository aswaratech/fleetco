import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// JobsService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. Same pattern
// the Trips / Customers / Drivers / Vehicles controllers use for
// their services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { JobsService, LIST_TAKE_DEFAULT, type JobDetail, type JobListItem } from "./jobs.service";
import {
  CreateJobSchema,
  ListJobsQuerySchema,
  UpdateJobSchema,
  type CreateJobInput,
  type JobSortColumn,
  type JobSortDir,
  type ListJobsQuery,
  type UpdateJobInput,
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
// Iter 17 ships the read path (GET list + GET :id); iter 18 layers
// the write path (POST create / PATCH update / DELETE remove) on top
// the same way Trips iter 8 → iter 9 and Customers iter 15 → iter 16
// staged.
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

  /**
   * Create a Job. The body is validated by ZodValidationPipe against
   * CreateJobSchema (jobs.schemas.ts); malformed payloads return HTTP
   * 400 with a clear per-field message. `createdById` comes from the
   * authenticated session (AuthGuard populates request.session per
   * ADR-0021 §6); it is never read from the body — the schema's
   * `.strict()` rejects it. `jobNumber` is generated server-side by
   * JobsService.create and is also never accepted from the body for
   * the same reason.
   *
   * Wire shape on the rare jobNumber-collision-after-retry conflict:
   *
   *   {
   *     "statusCode": 409,
   *     "message": "Could not generate a unique jobNumber after 3 attempts.",
   *     "field": "jobNumber"
   *   }
   *
   * Same field-token convention Customers (panNumber) / Drivers
   * (licenseNumber) / Vehicles (registrationNumber) use. The
   * translation from the service's ConflictException to this richer
   * response body lives here rather than in the service so the
   * service stays usable from other modules without the controller's
   * response shape leaking in. In practice the service's retry loop
   * makes this branch effectively unreachable; the mapping ships
   * defensively per the iter-18 kickoff.
   *
   * BadRequestException from the P2003 path (stale customerId) is
   * passed through unchanged — Nest's default exception filter
   * renders it as `{ statusCode: 400, message: "Customer <id> does
   * not exist." }`, which is the shape the web action layer parses
   * to surface an inline error on the customer picker.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateJobSchema)) body: CreateJobInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<JobDetail> {
    try {
      return await this.jobs.create(body, request.session.user.id);
    } catch (error) {
      throw remapJobNumberConflict(error);
    }
  }

  /**
   * Partial update. UpdateJobSchema enforces "at least one field"
   * and rejects unknown keys (so a client cannot smuggle `id`,
   * `createdById`, `customerId`, or `jobNumber` through this
   * endpoint). 404 on missing record. The cross-field rule on date
   * pairs is checked at the service layer against the merged shape;
   * a PATCH that touches a single date without its pair re-uses the
   * stored value for the rule.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateJobSchema)) body: UpdateJobInput,
  ): Promise<JobDetail> {
    return this.jobs.update(id, body);
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * job does not exist (service throws NotFoundException on P2025).
   *
   * No referencing slice exists yet in Phase 1 (Trips don't FK Job
   * today; that lands when a future slice introduces `Trip.jobId`).
   * When it does, this surface will gain a 409 delete-blocker branch
   * mirroring the Customer delete-blocker (iter 17) — see the
   * TODO(trip→job FK slice) note on JobsService.delete.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    await this.jobs.delete(id);
  }
}

// Translate the service's jobNumber-uniqueness ConflictException into
// a richer HTTP 409 body that names the offending field. Nest's
// default exception filter renders ConflictException as
// `{ statusCode: 409, message: "..." }`; the web action layer needs
// the field token to surface the error inline next to the (read-only)
// jobNumber display, although in practice the retry loop in
// JobsService.create makes this branch effectively unreachable.
//
// The function preserves the original message verbatim; only the
// response body shape is extended. Non-conflict errors pass through
// unchanged. Same shape and rationale as the Customers
// `remapPanConflict` helper in customers.controller.ts (iter 16).
function remapJobNumberConflict(error: unknown): unknown {
  if (error instanceof ConflictException) {
    const message = error.message;
    return new HttpException(
      { statusCode: HttpStatus.CONFLICT, message, field: "jobNumber" },
      HttpStatus.CONFLICT,
    );
  }
  return error;
}
