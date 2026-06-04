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
import type { Geofence } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// GeofencesService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern every other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GeofencesService, LIST_TAKE_DEFAULT } from "./geofences.service";
import {
  CreateGeofenceSchema,
  ListGeofencesQuerySchema,
  UpdateGeofenceSchema,
  type CreateGeofenceInput,
  type GeofenceSortColumn,
  type GeofenceSortDir,
  type ListGeofencesQuery,
  type UpdateGeofenceInput,
} from "./geofences.schemas";

export interface GeofencesListResponse {
  items: Geofence[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort/pagination back so the web client can render the
  // active-column indicator and paginator without re-deriving from the URL —
  // the same wire contract every Phase-1 list response carries.
  sortBy: GeofenceSortColumn;
  sortDir: GeofenceSortDir;
}

// Geofences feature controller (ADR-0030 G2). Route prefix `api/v1/geofences`
// matches the versioning convention of every other controller.
//
// Guards are applied at the CONTROLLER level — `@UseGuards(AuthGuard,
// RolesGuard)` in that order, so AuthGuard resolves the session first (401 for
// anonymous) and RolesGuard then enforces the per-route `@RequirePermission`
// (403 for authenticated-but-unauthorized). The RBAC split (ADR-0030 c5):
// read routes (list / detail) require `geofences:read` (ADMIN + OFFICE_STAFF —
// they see fences for the derived operational views); write routes (POST /
// PATCH / DELETE) require `geofences:write` (ADMIN only — redrawing a boundary
// is configuration at the users:manage tier). The closed Capability union
// makes a typo'd token a compile error.
@Controller("api/v1/geofences")
@UseGuards(AuthGuard, RolesGuard)
export class GeofencesController {
  constructor(private readonly geofences: GeofencesService) {}

  /**
   * List geofences with filter / sort / pagination. ZodValidationPipe runs
   * ListGeofencesQuerySchema over the query: rejects unknown keys (`.strict()`)
   * with 400, parses `type` (csv → enum array) and `customerId` (cuid), bounds
   * `skip` / `take`, and validates `sortBy` against the whitelist. Defaults
   * applied here mirror the service so the echoed values are the ones that ran.
   */
  @Get()
  @RequirePermission("geofences:read")
  async list(
    @Query(new ZodValidationPipe(ListGeofencesQuerySchema)) query: ListGeofencesQuery,
  ): Promise<GeofencesListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: GeofenceSortColumn = query.sortBy ?? "createdAt";
    const sortDir: GeofenceSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.geofences.list({
      skip,
      take,
      type: query.type,
      customerId: query.customerId,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one geofence by id. 404 when the row does not exist, with the id
   * named in the message. The service's getById throws NotFoundException.
   */
  @Get(":id")
  @RequirePermission("geofences:read")
  async getById(@Param("id") id: string): Promise<Geofence> {
    return this.geofences.getById(id);
  }

  /**
   * Create a Geofence. The body is validated against CreateGeofenceSchema
   * (malformed boundary / missing fields / type-ownership contradiction → 400).
   * `createdById` comes from the authenticated session (AuthGuard populates
   * request.session per ADR-0021); it is never read from the body, which the
   * schema's `.strict()` rejects. A self-intersecting ring → 400 (the service's
   * ST_IsValid gate); a stale customerId → 400 (Prisma P2003).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission("geofences:write")
  async create(
    @Body(new ZodValidationPipe(CreateGeofenceSchema)) body: CreateGeofenceInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<Geofence> {
    return this.geofences.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateGeofenceSchema enforces "at least one field" and
   * rejects unknown keys (a client cannot smuggle `id` / `createdById` /
   * `geometry`). 404 on missing record; 400 on a type-ownership contradiction
   * against the merged shape, a self-intersecting redrawn boundary, or a stale
   * customerId.
   */
  @Patch(":id")
  @RequirePermission("geofences:write")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateGeofenceSchema)) body: UpdateGeofenceInput,
  ): Promise<Geofence> {
    const updated = await this.geofences.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Geofence ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. HTTP 204 (no body) on success; 404 when the geofence does not
   * exist (service returns false for P2025). Nothing FKs into Geofence, so
   * there is no inbound-reference 409 here — the customer-side delete blocker
   * lives on CustomersService (ADR-0030 c4).
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission("geofences:write")
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.geofences.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Geofence ${id} not found`);
    }
  }
}
