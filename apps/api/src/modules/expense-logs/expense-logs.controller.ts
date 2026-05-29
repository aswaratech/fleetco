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

import {
  CreateExpenseLogSchema,
  ListExpenseLogsQuerySchema,
  UpdateExpenseLogSchema,
  type CreateExpenseLogInput,
  type ExpenseLogSortColumn,
  type ExpenseLogSortDir,
  type ListExpenseLogsQuery,
  type UpdateExpenseLogInput,
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
// Iter 21 shipped the read path (GET list + GET :id); iter 22 layers
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

  /**
   * Create an ExpenseLog. The body is validated by ZodValidationPipe
   * against CreateExpenseLogSchema (expense-logs.schemas.ts); malformed
   * payloads return HTTP 400 with a clear per-field message.
   * `createdById` comes from the authenticated session (AuthGuard
   * populates request.session per ADR-0021 §6); it is never read
   * from the body — the schema's `.strict()` rejects it.
   *
   * Unlike FuelLogsController.create, there is no derived field —
   * `amountPaisa` is the authoritative entered value, accepted
   * verbatim on the wire. The schema accepts `vehicleId` as
   * optional+nullable so a vehicle-agnostic expense (insurance
   * premium, office stationery) is a legitimate create. The service's
   * trip-vehicle consistency check fires only when BOTH `tripId` and
   * `vehicleId` are present on the request; otherwise it's skipped
   * (a vehicle-agnostic expense paired with a trip, or a
   * vehicle-attributed expense with no trip, both bypass the check).
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
    @Body(new ZodValidationPipe(CreateExpenseLogSchema)) body: CreateExpenseLogInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<ExpenseLogDetail> {
    return this.expenseLogs.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateExpenseLogSchema enforces "at least one
   * field" and rejects unknown keys (so a client cannot smuggle
   * `id`, `createdById`, or `vehicleId` through this endpoint).
   *
   * `vehicleId` is IMMUTABLE post-create: an attempt to PATCH it
   * surfaces as HTTP 400 from the Zod `.strict()` check (the schema
   * omits the key entirely; unknown-key rejection produces a
   * "Unrecognized key(s): \"vehicleId\"" message). Same precedent as
   * Jobs iter-18 customerId immutability and Fuel-logs iter-20
   * vehicleId immutability. See the schema's docblock for the
   * "rewriting history" rationale.
   *
   * `tripId` is MUTABLE: pairing / unpairing an expense with a trip
   * is a routine post-create correction (the operator may reconcile
   * receipts against trips later). 404 on missing record. The
   * trip-vehicle consistency rule is re-checked at the service
   * layer against the merged shape; a PATCH that touches `tripId`
   * to a non-null value while the stored row's vehicleId is
   * non-null re-validates against the stored vehicleId. When either
   * side of the merged shape is null, the check is skipped.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateExpenseLogSchema)) body: UpdateExpenseLogInput,
  ): Promise<ExpenseLogDetail> {
    return this.expenseLogs.update(id, body);
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * expense log does not exist (service throws NotFoundException on
   * P2025).
   *
   * No aggregate FK-references ExpenseLog under Restrict in Phase 1,
   * so the delete path has no 409 delete-blocker branch today. A
   * future Reports v1 slice that materializes per-expense summaries
   * may add an inbound FK; if it does under Restrict, this surface
   * will gain a 409 delete-blocker mirroring the Customer
   * delete-blocker (iter 17) — see the docblock on
   * ExpenseLogsService.delete.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    await this.expenseLogs.delete(id);
  }
}
