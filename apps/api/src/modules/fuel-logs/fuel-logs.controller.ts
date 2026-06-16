import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import type { Actor } from "../auth/driver-scope.service";
import { toUserRole } from "../auth/permissions";

import {
  CreateFuelLogSchema,
  ListFuelLogsQuerySchema,
  UpdateFuelLogSchema,
  type CreateFuelLogInput,
  type FuelLogSortColumn,
  type FuelLogSortDir,
  type ListFuelLogsQuery,
  type UpdateFuelLogInput,
} from "./fuel-logs.schemas";

// FuelLogsService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. Same pattern
// the Jobs / Customers / Trips / Drivers / Vehicles controllers use
// for their services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  FuelLogsService,
  LIST_TAKE_DEFAULT,
  type FuelLogDetail,
  type FuelLogListItem,
} from "./fuel-logs.service";

// Wire response shape for GET /api/v1/fuel-logs. Mirror of
// JobsListResponse (apps/api/src/modules/jobs/jobs.controller.ts iter
// 17) and every other vertical-slice list response. The echoed-back
// `skip` / `take` / `sortBy` / `sortDir` let the web client render
// its paginator and sortable-header without re-deriving the effective
// values from URL params — same convention every list surface uses
// so the web paginator component is portable.
export interface FuelLogsListResponse {
  items: FuelLogListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: FuelLogSortColumn;
  sortDir: FuelLogSortDir;
}

// Route prefix: `api/v1/fuel-logs`. Same versioning convention as the
// Jobs / Trips / Drivers / Vehicles / Customers controllers
// (controller-level prefix rather than a global one — see those
// controllers' equivalent comments).
//
// Per ADR-0021 §6 every route on this controller is auth-guarded. The
// guard is applied at the controller level so a future route added to
// this class inherits the gate by default — opt-out would require an
// explicit decorator, which is the right direction for an admin-only
// surface in Phase 1.
//
// Iter 19 shipped the read path (GET list + GET :id); iter 20 layers
// the write path (POST create / PATCH update / DELETE remove) on top
// the same way Jobs iter 17 → iter 18 staged.
@Controller("api/v1/fuel-logs")
@UseGuards(AuthGuard)
export class FuelLogsController {
  constructor(private readonly fuelLogs: FuelLogsService) {}

  // Build the acting principal from the AuthGuard-populated session. `role` is
  // coerced through `toUserRole` (the single fail-closed coercion the guard and
  // `/me` also use). Threading this is NOT a guard change — it is the same shape
  // as passing request.session.user.id as createdById (ADR-0034 c4/c7).
  private actorOf(request: AuthenticatedRequest): Actor {
    return {
      userId: request.session.user.id,
      role: toUserRole(request.session.user.role),
    };
  }

  /**
   * List fuel logs with filter / sort / pagination. ZodValidationPipe
   * runs `ListFuelLogsQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `vehicleId` / `tripId` from a cuid-shaped string
   *   - parses `startDate` / `endDate` from YYYY-MM-DD or ISO 8601
   *   - parses `skip` / `take` from strings into integers and
   *     enforces the same 1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *     (date / createdAt)
   *
   * Defaults applied here (when the validated query omits the field)
   * mirror the service's defaults so the response's echoed `sortBy` /
   * `sortDir` / `skip` / `take` are always the values that actually
   * ran the query. Same pattern as JobsController.list.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListFuelLogsQuerySchema)) query: ListFuelLogsQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<FuelLogsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: FuelLogSortColumn = query.sortBy ?? "date";
    const sortDir: FuelLogSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.fuelLogs.list(
      {
        skip,
        take,
        vehicleId: query.vehicleId,
        tripId: query.tripId,
        startDate: query.startDate,
        endDate: query.endDate,
        sortBy,
        sortDir,
      },
      this.actorOf(request),
    );
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one fuel log by id with the related Vehicle (always) and
   * Trip (nullable) eager-loaded for the detail page.
   * FuelLogsService.getById throws NotFoundException (mapped by
   * Nest's default exception filter to HTTP 404 per the
   * api-error-mapping runbook) when the row is missing; the
   * controller stays declarative — same shape as
   * JobsController.getById.
   */
  @Get(":id")
  async getById(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<FuelLogDetail> {
    return this.fuelLogs.getById(id, this.actorOf(request));
  }

  /**
   * Create a FuelLog. The body is validated by ZodValidationPipe
   * against CreateFuelLogSchema (fuel-logs.schemas.ts); malformed
   * payloads return HTTP 400 with a clear per-field message.
   * `createdById` comes from the authenticated session (AuthGuard
   * populates request.session per ADR-0021 §6); it is never read
   * from the body — the schema's `.strict()` rejects it.
   * `totalCostPaisa` is derived server-side by FuelLogsService.create
   * (see the docblock there) and is also rejected by `.strict()`.
   *
   * The service's trip-vehicle consistency check (BadRequestException
   * naming both registrations) and FK violations (P2003 →
   * BadRequestException naming the offending id) propagate as HTTP
   * 400 unchanged — Nest's default exception filter renders them as
   * `{ statusCode: 400, message: "<…>" }`, which is the shape the
   * web action layer parses to surface inline errors on the vehicle
   * / trip pickers.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateFuelLogSchema)) body: CreateFuelLogInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<FuelLogDetail> {
    return this.fuelLogs.create(body, request.session.user.id, this.actorOf(request));
  }

  /**
   * Partial update. UpdateFuelLogSchema enforces "at least one field"
   * and rejects unknown keys (so a client cannot smuggle `id`,
   * `createdById`, `totalCostPaisa`, or `vehicleId` through this
   * endpoint). 404 on missing record. The trip-vehicle consistency
   * rule is re-checked at the service layer against the merged
   * shape; a PATCH that touches `tripId` re-validates against the
   * stored `vehicleId`. `totalCostPaisa` is recomputed against the
   * merged `litersMl` × `pricePerLiterPaisa` whenever either factor
   * is part of the patch — same derivation as create.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateFuelLogSchema)) body: UpdateFuelLogInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<FuelLogDetail> {
    return this.fuelLogs.update(id, body, this.actorOf(request));
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * fuel log does not exist (service throws NotFoundException on
   * P2025).
   *
   * No aggregate FK-references FuelLog under Restrict in Phase 1, so
   * the delete path has no 409 delete-blocker branch today. A future
   * Reports v1 slice that materializes per-fill summaries may add an
   * inbound FK; if it does under Restrict, this surface will gain a
   * 409 delete-blocker mirroring the Customer delete-blocker (iter
   * 17) — see the docblock on FuelLogsService.delete.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.fuelLogs.delete(id, this.actorOf(request));
  }
}
