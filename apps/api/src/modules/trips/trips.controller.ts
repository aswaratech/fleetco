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

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// TripsService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime. Same pattern
// the Drivers and Vehicles controllers use for their services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  TripsService,
  LIST_TAKE_DEFAULT,
  type TripDetail,
  type TripListItem,
} from "./trips.service";
import {
  CreateTripSchema,
  ListTripsQuerySchema,
  UpdateTripSchema,
  type CreateTripInput,
  type ListTripsQuery,
  type TripSortColumn,
  type TripSortDir,
  type UpdateTripInput,
} from "./trips.schemas";

export interface TripsListResponse {
  items: TripListItem[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort back so the web client can render the
  // active-column indicator without re-deriving from URL params. The
  // defaults match the service: createdAt desc. Same wire contract as
  // DriversListResponse and VehiclesListResponse so the web client can
  // reuse its paginator and sortable-header components across all
  // three surfaces.
  sortBy: TripSortColumn;
  sortDir: TripSortDir;
}

// Route prefix: `api/v1/trips`. Same versioning convention as Drivers
// and Vehicles (controller-level prefix rather than a global one — see
// the matching comments in vehicles.controller.ts and
// drivers.controller.ts).
//
// Per ADR-0021 §6 every route on this controller is auth-guarded. The
// guard is applied at the controller level so a future route added to
// this class inherits the gate by default — opt-out would require an
// explicit decorator, which is the right direction for an admin-only
// surface in Phase 1.
//
// Iter 8 shipped the read path (GET list + GET :id). Iter 9 (this
// iter) layers the write path: POST for create, PATCH for diff-update,
// DELETE for hard delete. The five routes below match the Drivers
// controller surface in shape and validation conventions so the web
// client's API helpers and form patterns transfer across both modules
// without surprises.
@Controller("api/v1/trips")
@UseGuards(AuthGuard)
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  /**
   * List trips with filter / sort / pagination. ZodValidationPipe runs
   * `ListTripsQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `status` from a comma-separated string into a
   *     deduplicated TripStatus array
   *   - parses `skip` / `take` from strings into integers and enforces
   *     the same 1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *     (startedAt / endedAt / createdAt)
   *
   * Defaults applied here (when the validated query omits the field)
   * mirror the service's defaults so the response's echoed `sortBy` /
   * `sortDir` / `skip` / `take` are always the values that actually
   * ran the query. The same values become anchor points for the web
   * client's pagination and sort-indicator UI.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListTripsQuerySchema)) query: ListTripsQuery,
  ): Promise<TripsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: TripSortColumn = query.sortBy ?? "createdAt";
    const sortDir: TripSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.trips.list({
      skip,
      take,
      status: query.status,
      vehicleId: query.vehicleId,
      driverId: query.driverId,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one trip by id with the related Vehicle and Driver objects
   * nested for the detail page. The service-layer findById uses the
   * DETAIL_INCLUDE Prisma include; this method just unwraps the
   * not-found case into NotFoundException, which Nest's default
   * exception filter renders as HTTP 404 per the api-error-mapping
   * runbook.
   */
  @Get(":id")
  async getById(@Param("id") id: string): Promise<TripDetail> {
    const trip = await this.trips.findById(id);
    if (!trip) {
      throw new NotFoundException(`Trip ${id} not found`);
    }
    return trip;
  }

  /**
   * Create a Trip. The body is validated by ZodValidationPipe against
   * CreateTripSchema (trips.schemas.ts); malformed payloads (missing
   * vehicleId, illegal status, cross-field violation, etc.) return
   * HTTP 400 with a clear per-field message. `createdById` comes from
   * the authenticated session — AuthGuard populates request.session
   * per ADR-0021 §6 — and is never read from the body (`.strict()`
   * rejects it). The service throws BadRequestException with the
   * offending FK name when vehicleId or driverId references a
   * deleted (or never-existed) record.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateTripSchema)) body: CreateTripInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<TripDetail> {
    return this.trips.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateTripSchema rejects unknown keys (so a client
   * cannot smuggle `id` or `createdById` through this endpoint).
   * Cross-field validation runs against the merged shape inside the
   * service — Zod's superRefine sees only the partial body. The
   * service throws NotFoundException for a missing id and
   * BadRequestException for an illegal status transition or a
   * cross-field violation on the merged shape; Nest's default
   * exception filter renders both per the api-error-mapping runbook.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateTripSchema)) body: UpdateTripInput,
  ): Promise<TripDetail> {
    return this.trips.update(id, body);
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * trip does not exist (service throws NotFoundException for P2025).
   *
   * Phase 2 adds the fuel-log and GPS-ping aggregates that will
   * reference Trip by id; at that point this endpoint will either
   * switch to soft delete or grow a P2003 → 409 catch arm the same
   * way VehiclesController.remove / DriversController.remove did in
   * iter-9 (this iter). The decision is deferred until those
   * referencing aggregates land. The matching tech-debt entry will
   * be reopened then.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    await this.trips.delete(id);
  }
}
