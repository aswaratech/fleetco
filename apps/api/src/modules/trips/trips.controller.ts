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

// nestjs-pino's Logger is injected by NestJS via emitDecoratorMetadata (see
// apps/api/tsconfig.json); the class reference must remain a value import at
// runtime so the DI container can resolve it — the same reason TripsService is
// a value import below. nestjs-pino's LoggerModule is global (registered in
// app.module.ts), so TripsController resolves it without a TripsModule import.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Logger } from "nestjs-pino";

import { SLI_TRIP_CREATION_SUCCESS, SLI_TRIP_START_SUCCESS } from "../../common/sli";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";
import type { Actor } from "../auth/driver-scope.service";
import { toUserRole } from "../auth/permissions";

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
  constructor(
    private readonly trips: TripsService,
    private readonly logger: Logger,
  ) {}

  // Build the acting principal from the AuthGuard-populated session. `role` is
  // coerced through `toUserRole` (the single fail-closed coercion the guard and
  // `/me` also use), so the service-layer own-record predicate can never disagree
  // with the guard on how an unexpected role value is treated. Threading this is
  // NOT a guard change — it is the same shape as passing request.session.user.id
  // as createdById (ADR-0034 c4/c7).
  private actorOf(request: AuthenticatedRequest): Actor {
    return {
      userId: request.session.user.id,
      role: toUserRole(request.session.user.role),
    };
  }

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
    @Req() request: AuthenticatedRequest,
  ): Promise<TripsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: TripSortColumn = query.sortBy ?? "createdAt";
    const sortDir: TripSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.trips.list(
      {
        skip,
        take,
        status: query.status,
        vehicleId: query.vehicleId,
        driverId: query.driverId,
        sortBy,
        sortDir,
      },
      this.actorOf(request),
    );
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
  async getById(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<TripDetail> {
    const trip = await this.trips.findById(id, this.actorOf(request));
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
   *
   * SLI #2 (ADR-0011, ticket T_SLI2): this method emits one
   * trip-creation-success signal per attempt. The signal is scoped to
   * the post-validation create operation — `ZodValidationPipe` rejects a
   * malformed body with HTTP 400 *before* this method body runs, so
   * request-shape rejections never enter the try/catch below and are not
   * counted against the indicator (a scope boundary T_PERF's performance
   * budget inherits). On success the line carries
   * `{ sli: "trip_creation_success", sli_good: true }`; on a thrown error
   * it carries `sli_good: false` plus `error_kind` — the exception's
   * *class name only*, never `err.message`, which the trips FK errors
   * embed the literal vehicle/driver id into (Tier-3 operational data per
   * ADR-0013). The error is rethrown unchanged so the HTTP response (and
   * the runbook's api-error-mapping contract) is unaffected by the
   * instrumentation. The `sli` tag value comes from the shared
   * `SLI_TRIP_CREATION_SUCCESS` constant in `common/sli.ts`, not a literal.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateTripSchema)) body: CreateTripInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<TripDetail> {
    try {
      const trip = await this.trips.create(body, request.session.user.id, this.actorOf(request));
      this.logger.log({ sli: SLI_TRIP_CREATION_SUCCESS, sli_good: true });
      return trip;
    } catch (err) {
      // Log ONLY the exception class name (never err.message — ADR-0013):
      // the service's FK failures embed the literal vehicle/driver id in
      // their message. Narrow without casting through unknown/any.
      const errorKind = err instanceof Error ? err.constructor.name : "UnknownError";
      this.logger.log({ sli: SLI_TRIP_CREATION_SUCCESS, sli_good: false, error_kind: errorKind });
      throw err;
    }
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
    @Req() request: AuthenticatedRequest,
  ): Promise<TripDetail> {
    const actor = this.actorOf(request);
    // The "driver-app trip-start success" SLI (ADR-0034 c9). A trip-start is the
    // PATCH that transitions a trip to IN_PROGRESS; only those attempts count (a
    // notes-only edit, a stop → COMPLETED, or a cancel is not a start). Mirrors
    // the trip-creation-success try/catch in create(): success → sli_good:true;
    // a thrown error → sli_good:false + error_kind (the exception CLASS NAME
    // only, never err.message — it embeds vehicle/driver ids per ADR-0013),
    // rethrown unchanged. Counts every trip-start reaching the API regardless of
    // caller (the SLI is defined by the operation, c9). The own-record gate lives
    // in the service; this layer only instruments the start.
    if (body.status !== "IN_PROGRESS") {
      return this.trips.update(id, body, actor);
    }
    try {
      const trip = await this.trips.update(id, body, actor);
      this.logger.log({ sli: SLI_TRIP_START_SUCCESS, sli_good: true });
      return trip;
    } catch (err) {
      const errorKind = err instanceof Error ? err.constructor.name : "UnknownError";
      this.logger.log({ sli: SLI_TRIP_START_SUCCESS, sli_good: false, error_kind: errorKind });
      throw err;
    }
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * trip does not exist (service throws NotFoundException for P2025);
   * 409 when the trip is still referenced by another aggregate (service
   * throws ConflictException for P2003).
   *
   * The previously-deferred resolution is now landed (ADR-0029 T2,
   * commitment 7): GpsPing.tripId (onDelete: Restrict) makes Trip a
   * referenced aggregate, so TripsService.delete maps Prisma P2003 -> 409
   * the same way VehiclesController.remove / DriversController.remove do
   * — a 409 catch arm, NOT soft delete (which would be a new
   * cross-cutting pattern warranting its own ADR). FuelLog and
   * ExpenseLog (also onDelete: Restrict on tripId, shipped in Phase 1)
   * are covered by the same arm. See the service-layer delete()
   * docstring and docs/runbook/api-error-mapping.md (P2003
   * delete-when-referenced -> 409).
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.trips.delete(id, this.actorOf(request));
  }
}
