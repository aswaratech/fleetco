import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { RenewalRecord } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// RenewalsService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern every other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { RenewalsService, type RenewalsListResult } from "./renewals.service";
import {
  CreateRenewalSchema,
  ListRenewalsQuerySchema,
  type CreateRenewalInput,
  type ListRenewalsQuery,
} from "./renewals.schemas";

// Renewal-records controller (ADR-0049 F3), nested under the Vehicle
// aggregate: renewals ARE Vehicle-aggregate writes (the atomic renew updates
// the vehicle's compliance fields), so they ride the class-level `vehicles:*`
// token on the shared operational floor — office staff can already PATCH the
// same expiry fields today, so recording a renewal properly carries the same
// privilege (ADR-0049 c6). Append-only: no PATCH/DELETE routes exist.
@Controller("api/v1/vehicles/:vehicleId/renewals")
@UseGuards(AuthGuard, RolesGuard)
@RequirePermission("vehicles:*")
export class RenewalsController {
  constructor(private readonly renewals: RenewalsService) {}

  /** The atomic renew: record row + vehicle field update in one commit. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param("vehicleId") vehicleId: string,
    @Body(new ZodValidationPipe(CreateRenewalSchema)) body: CreateRenewalInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<RenewalRecord> {
    return this.renewals.renew(vehicleId, body, request.session.user.id);
  }

  /** The per-vehicle renewal history, newest first. */
  @Get()
  async list(
    @Param("vehicleId") vehicleId: string,
    @Query(new ZodValidationPipe(ListRenewalsQuerySchema)) query: ListRenewalsQuery,
  ): Promise<RenewalsListResult> {
    return this.renewals.list(vehicleId, query);
  }
}
