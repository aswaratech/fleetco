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
import type { Vehicle } from "@prisma/client";

import { AuthGuard } from "../auth/auth.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// VehiclesService and TripsService are injected by NestJS via
// emitDecoratorMetadata; the class references must remain value
// imports at runtime so the DI container can resolve them. See the
// matching comment in health.service.ts for the rationale.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { VehiclesService, DEFAULT_TAKE } from "./vehicles.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TripsService } from "../trips/trips.service";
import {
  CreateVehicleSchema,
  ListVehiclesQuerySchema,
  UpdateVehicleSchema,
  type CreateVehicleInput,
  type ListVehiclesQuery,
  type UpdateVehicleInput,
  type VehicleSortColumn,
  type VehicleSortDir,
} from "./vehicles.schemas";
import { ZodValidationPipe } from "./zod-validation.pipe";

export interface VehiclesListResponse {
  items: Vehicle[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort back so the web client can render the
  // active-column indicator without re-deriving from URL params. The
  // defaults match the service: createdAt desc.
  sortBy: VehicleSortColumn;
  sortDir: VehicleSortDir;
}

// Iter-12 wire shape for `GET /api/v1/vehicles/:id/stats`. The route
// surfaces four aggregations the Vehicle detail page renders in a
// "Lifetime stats" section: count + km + engine-hours (ADR-0036) from
// COMPLETED trips, plus the driver of the most-recently-started trip (any
// non-null `startedAt`). `totalHoursLogged` is integer tenths-of-an-hour
// (0 for a km-only vehicle); the web layer divides by 10 for display.
//
// The `startedAt` field is serialized as an ISO string for the wire
// (the service returns a `Date`); the controller does the conversion
// in `getStats()` below. Matches the project-wide convention that
// datetimes cross the API boundary as ISO strings.
export interface VehicleStatsResponse {
  vehicleId: string;
  completedTripCount: number;
  totalKmLogged: number;
  totalHoursLogged: number;
  mostRecentDriver: {
    id: string;
    fullName: string;
    tripId: string;
    startedAt: string;
  } | null;
}

// Route prefix: `api/v1/vehicles`. The existing AuthController uses no
// prefix (mounted at /me) and HealthController uses /health; a global
// prefix would break those and the better-auth handler at /auth/{*splat}.
// Versioning at the controller level keeps the API surface explicit and
// future-proofs the URL space without coupling unrelated controllers
// to the same prefix.
@Controller("api/v1/vehicles")
@UseGuards(AuthGuard)
export class VehiclesController {
  constructor(
    private readonly vehicles: VehiclesService,
    private readonly trips: TripsService,
  ) {}

  /**
   * List vehicles with filter / sort / pagination. ZodValidationPipe
   * runs `ListVehiclesQuerySchema` over the full query object, which:
   *   - rejects unknown query keys (`.strict()`) with HTTP 400
   *   - parses `status` / `kind` from comma-separated strings into
   *     deduplicated enum arrays
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
    @Query(new ZodValidationPipe(ListVehiclesQuerySchema)) query: ListVehiclesQuery,
  ): Promise<VehiclesListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? DEFAULT_TAKE;
    const sortBy: VehicleSortColumn = query.sortBy ?? "createdAt";
    const sortDir: VehicleSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.vehicles.list({
      skip,
      take,
      status: query.status,
      kind: query.kind,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  @Get(":id")
  async getById(@Param("id") id: string): Promise<Vehicle> {
    const vehicle = await this.vehicles.getById(id);
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }
    return vehicle;
  }

  /**
   * Per-vehicle lifetime stats — three scalar aggregations the
   * Vehicle detail page surfaces in iter 12: `completedTripCount`,
   * `totalKmLogged` (sum across COMPLETED trips), and the driver of
   * the most-recently-started trip.
   *
   * Existence is checked first via `vehicles.getById` so an unknown
   * id returns the same 404 shape as `GET /api/v1/vehicles/:id`
   * rather than a misleading `{ count: 0, total: 0, mostRecentDriver:
   * null }` response. The aggregation lives in TripsService (the
   * data is Trip rows); see the service-side docstring for the scope
   * decisions (COMPLETED-only, startedAt-not-createdAt for most-recent).
   *
   * The wire response serializes `mostRecentDriver.startedAt` as an
   * ISO string; the service returns a Date. No pagination, no query
   * params — stats are scalar.
   */
  @Get(":id/stats")
  async getStats(@Param("id") id: string): Promise<VehicleStatsResponse> {
    const vehicle = await this.vehicles.getById(id);
    if (!vehicle) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }

    const stats = await this.trips.statsForVehicle(id);

    return {
      vehicleId: id,
      completedTripCount: stats.completedTripCount,
      totalKmLogged: stats.totalKmLogged,
      totalHoursLogged: stats.totalHoursLogged,
      mostRecentDriver: stats.mostRecentDriver
        ? {
            id: stats.mostRecentDriver.id,
            fullName: stats.mostRecentDriver.fullName,
            tripId: stats.mostRecentDriver.tripId,
            startedAt: stats.mostRecentDriver.startedAt.toISOString(),
          }
        : null,
    };
  }

  /**
   * Create a Vehicle. The body is validated by ZodValidationPipe against
   * CreateVehicleSchema (vehicles.schemas.ts); malformed payloads return
   * HTTP 400 with a clear, per-field message. createdById comes from the
   * authenticated session (AuthGuard populates request.session); it is
   * never read from the body — the schema's `.strict()` rejects it.
   * Duplicate registrationNumber surfaces as HTTP 409 (mapped in the
   * service from Prisma's P2002 error code).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(CreateVehicleSchema)) body: CreateVehicleInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<Vehicle> {
    return this.vehicles.create(body, request.session.user.id);
  }

  /**
   * Partial update. UpdateVehicleSchema enforces "at least one field"
   * and rejects unknown keys (so a client cannot smuggle `id` or
   * `createdById` through this endpoint). 404 on missing record;
   * 409 on registrationNumber conflict (service maps P2002).
   */
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateVehicleSchema)) body: UpdateVehicleInput,
  ): Promise<Vehicle> {
    const updated = await this.vehicles.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }
    return updated;
  }

  /**
   * Hard delete. Returns HTTP 204 (no body) on success; 404 when the
   * vehicle does not exist (the service returns false for P2025).
   *
   * Future slice (Trips) will likely change this to either a soft delete
   * or a block-when-referenced check, because once Trips reference
   * Vehicle by id, hard-deleting a Vehicle that has Trips would either
   * orphan the Trips (data loss) or fail at the DB layer (foreign-key
   * Restrict, surfacing as Prisma P2003 — which we would then map to
   * HTTP 409 the same way P2002 is mapped today). The service-layer
   * comment on `delete` records this same plan; this controller-side
   * note exists so a future reader scanning the public surface for
   * "what happens when I DELETE a vehicle that has trips" finds the
   * answer here without needing to open the service.
   */
  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    const deleted = await this.vehicles.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Vehicle ${id} not found`);
    }
  }
}
