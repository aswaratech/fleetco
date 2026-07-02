import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { ServiceRecord } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// ServiceRecordsService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. Same pattern every
// other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ServiceRecordsService, LIST_TAKE_DEFAULT } from "./service-records.service";
import {
  CreateServiceRecordSchema,
  ListServiceRecordsQuerySchema,
  UpdateServiceRecordSchema,
  type CreateServiceRecordInput,
  type ListServiceRecordsQuery,
  type ServiceRecordSortColumn,
  type ServiceRecordSortDir,
  type UpdateServiceRecordInput,
} from "./service-records.schemas";

export interface ServiceRecordsListResponse {
  items: ServiceRecord[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort/pagination back so the web client can render the
  // active-column indicator and paginator without re-deriving from the URL.
  sortBy: ServiceRecordSortColumn;
  sortDir: ServiceRecordSortDir;
}

// ServiceRecords feature controller (ADR-0037 B3). Route prefix
// `api/v1/service-records`. AuthGuard on every route (controller-level so a
// future route inherits the gate), mirroring the Phase-1 aggregate convention —
// admin/office data entry, not an RBAC-split surface.
@Controller("api/v1/service-records")
// RBAC (2026-07-02 hardening): the maintenance:* capability gates every route in this
// controller on the composed AuthGuard + RolesGuard chain (ADR-0028 c5). Before
// this, the controller was AuthGuard-only and open to any signed-in role.
@RequirePermission("maintenance:*")
@UseGuards(AuthGuard, RolesGuard)
export class ServiceRecordsController {
  constructor(private readonly records: ServiceRecordsService) {}

  /**
   * List service records with filter / sort / pagination. ZodValidationPipe
   * runs ListServiceRecordsQuerySchema over the query: rejects unknown keys
   * (`.strict()`) with 400, parses `vehicleId` / `serviceScheduleId` (cuid),
   * bounds `skip` / `take`, validates `sortBy` against the whitelist. Defaults
   * applied here mirror the service so the echoed values are the ones that ran.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListServiceRecordsQuerySchema)) query: ListServiceRecordsQuery,
  ): Promise<ServiceRecordsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: ServiceRecordSortColumn = query.sortBy ?? "performedAt";
    const sortDir: ServiceRecordSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.records.list({
      skip,
      take,
      vehicleId: query.vehicleId,
      serviceScheduleId: query.serviceScheduleId,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one record by id. 404 when the row does not exist, with the id named
   * in the message. The service's getById throws NotFoundException.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<ServiceRecord> {
    return this.records.getById(id);
  }

  /**
   * Create a ServiceRecord. The body is validated against
   * CreateServiceRecordSchema (malformed / missing fields → 400). `createdById`
   * comes from the authenticated session (ADR-0021); never the body, which the
   * schema's `.strict()` rejects. A stale vehicleId, a missing schedule, or a
   * schedule on a different vehicle surfaces as 400 (the service's checks).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateServiceRecordSchema)) body: CreateServiceRecordInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<ServiceRecord> {
    return this.records.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateServiceRecordSchema enforces "at least one field" and
   * rejects unknown keys (a client cannot smuggle `id` / `createdById` /
   * `vehicleId`). 404 on missing record; 400 on a stale / mismatched
   * serviceScheduleId re-link (the service's vehicle-match check).
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateServiceRecordSchema)) body: UpdateServiceRecordInput,
  ): Promise<ServiceRecord> {
    const updated = await this.records.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Service record ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. HTTP 204 (no body) on success; 404 when the record does not
   * exist (service returns false for P2025). Nothing FKs into ServiceRecord, so
   * there is no inbound-reference 409 here.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.records.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Service record ${id} not found`);
    }
  }
}
