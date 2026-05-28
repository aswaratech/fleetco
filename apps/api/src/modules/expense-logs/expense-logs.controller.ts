import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";

import {
  ListExpenseLogsQuerySchema,
  type ExpenseLogSortColumn,
  type ExpenseLogSortDir,
  type ListExpenseLogsQuery,
} from "./expense-logs.schemas";

// ExpenseLogsService is injected by NestJS via emitDecoratorMetadata;
// the class reference must remain a value import at runtime. Same
// pattern every other vertical-slice controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  ExpenseLogsService,
  LIST_TAKE_DEFAULT,
  type ExpenseLogDetail,
  type ExpenseLogListItem,
} from "./expense-logs.service";

// Wire response shape for GET /api/v1/expense-logs. Mirror of
// FuelLogsListResponse (apps/api/src/modules/fuel-logs/fuel-logs.controller.ts
// iter 19) and every other vertical-slice list response. The echoed-
// back `skip` / `take` / `sortBy` / `sortDir` let the web client render
// its paginator and sortable-header without re-deriving the effective
// values from URL params — same convention every list surface uses so
// the web paginator component is portable.
export interface ExpenseLogsListResponse {
  items: ExpenseLogListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: ExpenseLogSortColumn;
  sortDir: ExpenseLogSortDir;
}

// Route prefix: `api/v1/expense-logs`. Same versioning convention as
// the Fuel logs / Jobs / Trips / Drivers / Vehicles / Customers
// controllers (controller-level prefix rather than a global one — see
// those controllers' equivalent comments).
//
// Per ADR-0021 §6 every route on this controller is auth-guarded. The
// guard is applied at the controller level so a future route added to
// this class inherits the gate by default — opt-out would require an
// explicit decorator, which is the right direction for an admin-only
// surface in Phase 1.
//
// Iter 21 ships the read path (GET list + GET :id); iter 22 layers
// the write path (POST create / PATCH update / DELETE remove) on top
// the same way Fuel logs iter 19 → iter 20 and Jobs iter 17 → iter 18
// staged.
@Controller("api/v1/expense-logs")
@UseGuards(AuthGuard)
export class ExpenseLogsController {
  constructor(private readonly expenseLogs: ExpenseLogsService) {}

  /**
   * List expense logs with filter / sort / pagination.
   * ZodValidationPipe runs `ListExpenseLogsQuerySchema` over the full
   * query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `vehicleId` / `tripId` from a cuid-shaped string
   *   - parses `category` from the eight-value `ExpenseCategory` enum
   *   - parses `startDate` / `endDate` from YYYY-MM-DD or ISO 8601
   *   - parses `skip` / `take` from strings into integers and
   *     enforces the same 1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *     (date / amountPaisa / createdAt)
   *
   * Defaults applied here (when the validated query omits the field)
   * mirror the service's defaults so the response's echoed `sortBy` /
   * `sortDir` / `skip` / `take` are always the values that actually
   * ran the query. Same pattern as FuelLogsController.list /
   * JobsController.list.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListExpenseLogsQuerySchema)) query: ListExpenseLogsQuery,
  ): Promise<ExpenseLogsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: ExpenseLogSortColumn = query.sortBy ?? "date";
    const sortDir: ExpenseLogSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.expenseLogs.list({
      skip,
      take,
      vehicleId: query.vehicleId,
      tripId: query.tripId,
      category: query.category,
      startDate: query.startDate,
      endDate: query.endDate,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one expense log by id with the related Vehicle (nullable)
   * and Trip (nullable) eager-loaded for the detail page.
   * ExpenseLogsService.getById throws NotFoundException (mapped by
   * Nest's default exception filter to HTTP 404 per the
   * api-error-mapping runbook) when the row is missing; the
   * controller stays declarative — same shape as
   * FuelLogsController.getById.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<ExpenseLogDetail> {
    return this.expenseLogs.getById(id);
  }
}
