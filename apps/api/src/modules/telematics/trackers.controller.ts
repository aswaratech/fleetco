import {
  Body,
  Controller,
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
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// TrackersService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern every other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TrackersService, LIST_TAKE_DEFAULT, type TrackerWithVehicle } from "./trackers.service";
import {
  CreateTrackerSchema,
  ListTrackersQuerySchema,
  UpdateTrackerSchema,
  type CreateTrackerInput,
  type ListTrackersQuery,
  type TrackerSortColumn,
  type TrackerSortDir,
  type UpdateTrackerInput,
} from "./trackers.schemas";

export interface TrackersListResponse {
  items: TrackerWithVehicle[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort/pagination back so the web client can render the
  // active-column indicator and paginator without re-deriving from the URL —
  // the same wire contract every list response carries.
  sortBy: TrackerSortColumn;
  sortDir: TrackerSortDir;
}

// TrackerDevice register controller (ADR-0042 M4). Route prefix
// `api/v1/telematics/trackers` — the tracker register is telematics
// configuration and rides in the telematics module beside the ingest
// adapter that reads it (the schema's "Owned by
// apps/api/src/modules/telematics/" note).
//
// Guards are applied at the CONTROLLER level — `@UseGuards(AuthGuard,
// RolesGuard)` in that order, so AuthGuard resolves the session first (401
// for anonymous) and RolesGuard then enforces the per-route
// `@RequirePermission` (403 for authenticated-but-unauthorized). The RBAC
// split (ADR-0042 c6, the geofences calculus): read routes require
// `trackers:read` (ADMIN + OFFICE_STAFF — the office sees which vehicle
// carries which unit); write routes require `trackers:write` (ADMIN only —
// registering hardware and re-pointing a vehicle's identity on the map is
// configuration at the users:manage tier).
//
// There is NO delete route: ADR-0042 defines none. Unassign frees the
// vehicle slot; RETIRED ends the device lifecycle with the row kept.
@Controller("api/v1/telematics/trackers")
@UseGuards(AuthGuard, RolesGuard)
export class TrackersController {
  constructor(private readonly trackers: TrackersService) {}

  /**
   * List tracker devices with filter / sort / pagination. ZodValidationPipe
   * runs ListTrackersQuerySchema over the query: rejects unknown keys
   * (`.strict()`) with 400, parses `status` (csv → enum array) and
   * `vehicleId` (cuid), bounds `skip` / `take`, and validates `sortBy`
   * against the whitelist. Defaults applied here mirror the service so the
   * echoed values are the ones that ran.
   */
  @Get()
  @RequirePermission("trackers:read")
  async list(
    @Query(new ZodValidationPipe(ListTrackersQuerySchema)) query: ListTrackersQuery,
  ): Promise<TrackersListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: TrackerSortColumn = query.sortBy ?? "createdAt";
    const sortDir: TrackerSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.trackers.list({
      skip,
      take,
      status: query.status,
      vehicleId: query.vehicleId,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one tracker by id. 404 when the row does not exist, with the id
   * named in the message.
   */
  @Get(":id")
  @RequirePermission("trackers:read")
  async getById(@Param("id") id: string): Promise<TrackerWithVehicle> {
    return this.trackers.getById(id);
  }

  /**
   * Register a tracker device. Body validated against CreateTrackerSchema
   * (bad IMEI / RETIRED-while-assigned → 400). `createdById` comes from the
   * authenticated session; it is never read from the body, which the
   * schema's `.strict()` rejects. Duplicate IMEI or an already-tracked
   * vehicle → 409 naming the field; a stale vehicleId → 400.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission("trackers:write")
  async create(
    @Body(new ZodValidationPipe(CreateTrackerSchema)) body: CreateTrackerInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<TrackerWithVehicle> {
    return this.trackers.create(body, request.session.user.id);
  }

  /**
   * Partial update — assign/unassign the vehicle, lifecycle transitions,
   * label/SIM edits. UpdateTrackerSchema enforces "at least one field" and
   * rejects unknown keys. 404 on missing record; 400 on a
   * RETIRED-while-assigned merged shape or a stale vehicleId; 409 on a
   * unique collision (imei / vehicle slot).
   */
  @Patch(":id")
  @RequirePermission("trackers:write")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateTrackerSchema)) body: UpdateTrackerInput,
  ): Promise<TrackerWithVehicle> {
    const updated = await this.trackers.update(id, body);
    if (!updated) {
      throw new NotFoundException(`Tracker ${id} not found`);
    }
    return updated;
  }
}
