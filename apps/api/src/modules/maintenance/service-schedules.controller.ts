import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { ServiceSchedule } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// ServiceSchedulesService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern every other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ServiceSchedulesService, LIST_TAKE_DEFAULT } from "./service-schedules.service";
import {
  CreateServiceScheduleSchema,
  ListServiceSchedulesQuerySchema,
  UpdateServiceScheduleSchema,
  type CreateServiceScheduleInput,
  type ListServiceSchedulesQuery,
  type ServiceScheduleSortColumn,
  type ServiceScheduleSortDir,
  type UpdateServiceScheduleInput,
} from "./service-schedules.schemas";

export interface ServiceSchedulesListResponse {
  items: ServiceSchedule[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort/pagination back so the web client can render the
  // active-column indicator and paginator without re-deriving from the URL —
  // the same wire contract every Phase-1 list response carries.
  sortBy: ServiceScheduleSortColumn;
  sortDir: ServiceScheduleSortDir;
}

// ServiceSchedules feature controller (ADR-0037 B3). Route prefix
// `api/v1/service-schedules` matches the versioning convention of every other
// controller.
//
// Per ADR-0021 §6 every route is auth-guarded; the guard is applied at the
// controller level so a future route inherits the gate by default. AuthGuard
// (not RolesGuard) mirrors the Phase-1 aggregate convention the kickoff names —
// the maintenance aggregate is admin/office data entry, not a Tier-5 / RBAC-
// split surface like telematics or geofences. (A future RBAC tightening, e.g.
// a maintenance:write capability, would add RolesGuard the same opt-in way the
// geofences controller does.)
@Controller("api/v1/service-schedules")
// RBAC (2026-07-02 hardening): the maintenance:* capability gates every route in this
// controller on the composed AuthGuard + RolesGuard chain (ADR-0028 c5). Before
// this, the controller was AuthGuard-only and open to any signed-in role.
@RequirePermission("maintenance:*")
@UseGuards(AuthGuard, RolesGuard)
export class ServiceSchedulesController {
  constructor(private readonly schedules: ServiceSchedulesService) {}

  /**
   * List service schedules with filter / sort / pagination. ZodValidationPipe
   * runs ListServiceSchedulesQuerySchema over the query: rejects unknown keys
   * (`.strict()`) with 400, parses `vehicleId` (cuid) and `status` (csv → enum
   * array), bounds `skip` / `take`, and validates `sortBy` against the
   * whitelist. Defaults applied here mirror the service so the echoed values
   * are the ones that ran the query.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListServiceSchedulesQuerySchema)) query: ListServiceSchedulesQuery,
  ): Promise<ServiceSchedulesListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: ServiceScheduleSortColumn = query.sortBy ?? "createdAt";
    const sortDir: ServiceScheduleSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.schedules.list({
      skip,
      take,
      vehicleId: query.vehicleId,
      status: query.status,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one schedule by id. 404 when the row does not exist, with the id
   * named in the message. The service's getById throws NotFoundException.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<ServiceSchedule> {
    return this.schedules.getById(id);
  }

  /**
   * Create a ServiceSchedule. The body is validated against
   * CreateServiceScheduleSchema (malformed / missing fields → 400).
   * `createdById` comes from the authenticated session (AuthGuard populates
   * request.session per ADR-0021); it is never read from the body, which the
   * schema's `.strict()` rejects.
   *
   * A duplicate name on the same vehicle surfaces as HTTP 409 with the
   * `field: "name"` body token so the web action layer can highlight the name
   * input. A stale vehicleId, or an ENGINE_HOURS schedule on a km-only vehicle,
   * surfaces as 400 (the service's checks).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateServiceScheduleSchema)) body: CreateServiceScheduleInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServiceSchedule> {
    try {
      return await this.schedules.create(body, request.session.user.id);
    } catch (error) {
      throw remapNameConflict(error);
    }
  }

  /**
   * Partial update. UpdateServiceScheduleSchema enforces "at least one field"
   * and rejects unknown keys (a client cannot smuggle `id` / `createdById` /
   * `vehicleId`). 404 on missing record; 409 on a name conflict (with the
   * `field: "name"` token); 400 on a stale vehicle / meter-consistency
   * violation when intervalType changes.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateServiceScheduleSchema)) body: UpdateServiceScheduleInput,
  ): Promise<ServiceSchedule> {
    let updated: ServiceSchedule | null;
    try {
      updated = await this.schedules.update(id, body);
    } catch (error) {
      throw remapNameConflict(error);
    }
    if (!updated) {
      throw new NotFoundException(`Service schedule ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. HTTP 204 (no body) on success; 404 when the schedule does not
   * exist (service returns false for P2025); 409 when a ServiceRecord
   * references the schedule (the service's P2003 → ConflictException arm — no
   * `field` token because a delete-block is not a field-level error).
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.schedules.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Service schedule ${id} not found`);
    }
  }
}

// Translate the service's name-uniqueness ConflictException into a richer HTTP
// 409 body that names the offending field, so the web action layer can surface
// the error inline next to the name input. Mirror of the customers
// `remapPanConflict` helper. Only the create / update paths call this; the
// delete-blocker ConflictException (no field token) bubbles untouched. The
// service builds the message with the offending name, preserved verbatim here.
function remapNameConflict(error: unknown): unknown {
  if (error instanceof ConflictException) {
    return new HttpException(
      { statusCode: HttpStatus.CONFLICT, message: error.message, field: "name" },
      HttpStatus.CONFLICT,
    );
  }
  return error;
}
