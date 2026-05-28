import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";

import {
  ListFuelLogsQuerySchema,
  type FuelLogSortColumn,
  type FuelLogSortDir,
  type ListFuelLogsQuery,
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
// Iter 19 ships the read path (GET list + GET :id); iter 20 layers
// the write path (POST create / PATCH update / DELETE remove) on top
// the same way Jobs iter 17 → iter 18 staged.
@Controller("api/v1/fuel-logs")
@UseGuards(AuthGuard)
export class FuelLogsController {
  constructor(private readonly fuelLogs: FuelLogsService) {}

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
  ): Promise<FuelLogsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: FuelLogSortColumn = query.sortBy ?? "date";
    const sortDir: FuelLogSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.fuelLogs.list({
      skip,
      take,
      vehicleId: query.vehicleId,
      tripId: query.tripId,
      startDate: query.startDate,
      endDate: query.endDate,
      sortBy,
      sortDir,
    });
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
  async getById(@Param("id") id: string): Promise<FuelLogDetail> {
    return this.fuelLogs.getById(id);
  }
}
