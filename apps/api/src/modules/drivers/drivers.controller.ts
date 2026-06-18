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
import type { Driver } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// DriversService and TripsService are injected by NestJS via
// emitDecoratorMetadata; the class references must remain value
// imports at runtime. Same pattern the Vehicles controller uses for
// VehiclesService + TripsService.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DriversService, LIST_TAKE_DEFAULT } from "./drivers.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TripsService } from "../trips/trips.service";
import {
  CreateDriverSchema,
  ListDriversQuerySchema,
  UpdateDriverSchema,
  type CreateDriverInput,
  type DriverSortColumn,
  type DriverSortDir,
  type ListDriversQuery,
  type UpdateDriverInput,
} from "./drivers.schemas";

export interface DriversListResponse {
  items: Driver[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort back so the web client can render the
  // active-column indicator without re-deriving from URL params. The
  // defaults match the service: createdAt desc. Same wire contract as
  // VehiclesListResponse so the web client can reuse its paginator and
  // sortable-header components across both surfaces.
  sortBy: DriverSortColumn;
  sortDir: DriverSortDir;
}

// Iter-13 wire shape for `GET /api/v1/drivers/:id/stats`. The route
// surfaces four aggregations the Driver detail page renders in a
// "Lifetime stats" section: count + km + engine-hours (ADR-0036) from
// COMPLETED trips, plus the vehicle paired with the most-recently-started
// trip (any non-null `startedAt`). Symmetric mirror of VehicleStatsResponse.
// `totalHoursLogged` is integer tenths-of-an-hour (0 for a km-only fleet);
// the web layer divides by 10 for display.
//
// The `startedAt` field is serialized as an ISO string for the wire
// (the service returns a `Date`); the controller does the conversion
// in `getStats()` below. Matches the project-wide convention that
// datetimes cross the API boundary as ISO strings.
export interface DriverStatsResponse {
  driverId: string;
  completedTripCount: number;
  totalKmLogged: number;
  totalHoursLogged: number;
  mostRecentVehicle: {
    id: string;
    registrationNumber: string;
    tripId: string;
    startedAt: string;
  } | null;
}

// Route prefix: `api/v1/drivers`. Same versioning convention as
// Vehicles (controller-level prefix rather than a global one — see the
// matching comment in vehicles.controller.ts).
//
// Per ADR-0021 §6 every route on this controller is auth-guarded. The
// guard is applied at the controller level so a future route added to
// this class inherits the gate by default — opt-out would require an
// explicit decorator, which is the right direction for an admin-only
// surface in Phase 1.
//
// Iter 6 shipped the read path (GET list + GET :id); iter 7 layers the
// write path (POST / PATCH / DELETE) on top. The five routes below
// match the Vehicles surface in shape and validation conventions so
// the web client's API helpers and form patterns transfer across both
// modules without surprises.
@Controller("api/v1/drivers")
@UseGuards(AuthGuard)
export class DriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly trips: TripsService,
  ) {}

  /**
   * List drivers with filter / sort / pagination. ZodValidationPipe
   * runs `ListDriversQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `status` / `licenseClass` from comma-separated strings
   *     into deduplicated enum arrays
   *   - parses `skip` / `take` from strings into integers and enforces
   *     the same 1..200 ceiling as the service
   *   - validates `sortBy` against the sortable-column whitelist
   *
   * Defaults applied here (when the validated query omits the field)
   * mirror the service's defaults so the response's echoed `sortBy` /
   * `sortDir` / `skip` / `take` are always the values that actually
   * ran the query. The same values become anchor points for the web
   * client's pagination and sort-indicator UI.
   */
  @Get()
  async list(
    @Query(new ZodValidationPipe(ListDriversQuerySchema)) query: ListDriversQuery,
  ): Promise<DriversListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: DriverSortColumn = query.sortBy ?? "createdAt";
    const sortDir: DriverSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.drivers.list({
      skip,
      take,
      status: query.status,
      licenseClass: query.licenseClass,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  @Get(":id")
  async getById(@Param("id") id: string): Promise<Driver> {
    const driver = await this.drivers.findById(id);
    if (!driver) {
      throw new NotFoundException(`Driver ${id} not found`);
    }
    return driver;
  }

  /**
   * Per-driver lifetime stats — three scalar aggregations the Driver
   * detail page surfaces in iter 13 (the symmetric mirror of the
   * iter-12 vehicle-side route): `completedTripCount`, `totalKmLogged`
   * (sum across COMPLETED trips), and the vehicle paired with the
   * most-recently-started trip.
   *
   * Existence is checked first via `drivers.findById` so an unknown id
   * returns the same 404 shape as `GET /api/v1/drivers/:id` rather
   * than a misleading `{ count: 0, total: 0, mostRecentVehicle: null }`
   * response. The aggregation lives in TripsService (the data is Trip
   * rows); see the service-side docstring for the scope decisions
   * (COMPLETED-only, startedAt-not-createdAt for most-recent).
   *
   * The wire response serializes `mostRecentVehicle.startedAt` as an
   * ISO string; the service returns a Date. No pagination, no query
   * params — stats are scalar.
   */
  @Get(":id/stats")
  async getStats(@Param("id") id: string): Promise<DriverStatsResponse> {
    const driver = await this.drivers.findById(id);
    if (!driver) {
      throw new NotFoundException(`Driver ${id} not found`);
    }

    const stats = await this.trips.statsForDriver(id);

    return {
      driverId: id,
      completedTripCount: stats.completedTripCount,
      totalKmLogged: stats.totalKmLogged,
      totalHoursLogged: stats.totalHoursLogged,
      mostRecentVehicle: stats.mostRecentVehicle
        ? {
            id: stats.mostRecentVehicle.id,
            registrationNumber: stats.mostRecentVehicle.registrationNumber,
            tripId: stats.mostRecentVehicle.tripId,
            startedAt: stats.mostRecentVehicle.startedAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * Create a Driver. The body is validated by ZodValidationPipe against
   * CreateDriverSchema (drivers.schemas.ts); malformed payloads return
   * HTTP 400 with a clear, per-field message. createdById comes from
   * the authenticated session (AuthGuard populates request.session per
   * ADR-0021 §6); it is never read from the body — the schema's
   * `.strict()` rejects it. Duplicate licenseNumber surfaces as HTTP
   * 409 (mapped in the service from Prisma's P2002 error code per
   * docs/runbook/api-error-mapping.md).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateDriverSchema)) body: CreateDriverInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<Driver> {
    return this.drivers.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateDriverSchema enforces "at least one field"
   * and rejects unknown keys (so a client cannot smuggle `id` or
   * `createdById` through this endpoint). 404 on missing record;
   * 409 on licenseNumber conflict (service maps P2002). The service
   * also applies the terminated-transition rule (see
   * docs/glossary.md#Termination transition) so a PATCH that toggles
   * status into or out of TERMINATED touches `terminatedAt` per the
   * rule's four-direction truth table.
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateDriverSchema)) body: UpdateDriverInput,
  ): Promise<Driver> {
    const updated = await this.drivers.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Driver ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * driver does not exist (the service returns false for P2025).
   *
   * Future slice (Trips) will likely change this to either a soft
   * delete or a block-when-referenced check, because once Trips
   * reference Driver by id, hard-deleting a Driver who has Trips
   * would either orphan the Trips (data loss) or fail at the DB
   * layer (foreign-key Restrict → Prisma P2003, which we would then
   * map to HTTP 409 the same way P2002 is mapped today). The
   * service-layer comment on `delete` records this same plan; this
   * controller-side note exists so a future reader scanning the
   * public surface for "what happens when I DELETE a driver that has
   * trips" finds the answer here without needing to open the service.
   * Mirrors VehiclesController.remove for the same reasons.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.drivers.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Driver ${id} not found`);
    }
  }
}
