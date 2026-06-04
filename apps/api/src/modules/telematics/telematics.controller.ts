import {
  BadRequestException,
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

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

import {
  GeofenceStatusQuerySchema,
  IngestBatchSchema,
  ListPingsQuerySchema,
  type GeofenceStatusQuery,
  type IngestBatchInput,
  type ListPingsQuery,
  type PingSortColumn,
  type PingSortDir,
} from "./telematics.schemas";

// TelematicsService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime. Same pattern every other
// controller uses for its service. The read-path types alongside it are
// type-only imports.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  LIST_TAKE_DEFAULT,
  TelematicsService,
  type GeofenceQuery,
  type LocationFix,
  type RawPingItem,
} from "./telematics.service";

// 202 Accepted acknowledgement (ADR-0029 commitment 10): the write is async,
// so the body does NOT echo the rows (they do not exist yet). It returns the
// count accepted and the BullMQ job id for correlation — both safe,
// non-location values.
export interface IngestAck {
  accepted: number;
  jobId: string | null;
}

// Wire response for GET …/vehicles/:vehicleId/pings (gps:read-raw). Mirror of
// every Phase-1 list response (`{ items, total, skip, take, sortBy, sortDir }`)
// so the web paginator/sortable-header component is portable.
export interface RawPingsListResponse {
  items: RawPingItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: PingSortColumn;
  sortDir: PingSortDir;
}

// Wire response for GET …/vehicles/:vehicleId/location (gps:read-derived). The
// single latest fix, or null when the vehicle has no ping.
export interface VehicleLocationResponse {
  vehicleId: string;
  fix: LocationFix | null;
}

// The geofence echoed back on a geofence-status response (so the caller sees
// what was evaluated). The polygon case echoes only the vertex count, not the
// whole ring — enough context without bloating the response.
export type GeofenceEcho =
  | { kind: "circle"; centerLatitude: number; centerLongitude: number; radiusMeters: number }
  | { kind: "polygon"; vertexCount: number };

// Wire response for GET …/vehicles/:vehicleId/geofence-status
// (gps:read-derived). A single boolean (null when the vehicle has no fix) plus
// the fix time it was evaluated against — NO coordinates (Tier-3 derived
// status, ADR-0027 c6).
export interface GeofenceStatusResponse {
  vehicleId: string;
  geofence: GeofenceEcho;
  inside: boolean | null;
  latestFixAt: Date | null;
}

// Narrow the validated geofence-status query (circle XOR polygon, guaranteed
// by the schema's superRefine) into the service's GeofenceQuery union. The
// explicit field checks avoid a non-null assertion and keep the function total
// — the throw is unreachable after the refine but fails closed if it drifts.
function toGeofenceQuery(query: GeofenceStatusQuery): GeofenceQuery {
  if (query.polygon) {
    return { kind: "polygon", wkt: query.polygon.wkt, vertexCount: query.polygon.vertexCount };
  }
  if (
    query.centerLatitude !== undefined &&
    query.centerLongitude !== undefined &&
    query.radiusMeters !== undefined
  ) {
    return {
      kind: "circle",
      centerLatitude: query.centerLatitude,
      centerLongitude: query.centerLongitude,
      radiusMeters: query.radiusMeters,
    };
  }
  throw new BadRequestException("A geofence (circle or polygon) is required.");
}

// Build the safe-to-echo geofence descriptor for the response.
function describeGeofence(geofence: GeofenceQuery): GeofenceEcho {
  if (geofence.kind === "circle") {
    return {
      kind: "circle",
      centerLatitude: geofence.centerLatitude,
      centerLongitude: geofence.centerLongitude,
      radiusMeters: geofence.radiusMeters,
    };
  }
  return { kind: "polygon", vertexCount: geofence.vertexCount };
}

// Telematics feature controller (ADR-0029 commitment 2). The route prefix
// `api/v1/telematics` matches the versioning convention of every other
// controller.
//
// Guards are applied at the CONTROLLER level — `@UseGuards(AuthGuard,
// RolesGuard)` in that order, so AuthGuard resolves the session first (401 for
// anonymous) and RolesGuard then enforces the per-route `@RequirePermission`
// (403 for authenticated-but-unauthorized). Controller-level placement is
// forward-compatible with T5: the raw/derived READ routes added there declare
// their own `@RequirePermission("gps:read-raw" / "gps:read-derived")` and
// inherit the same composed chain without re-decorating.
@Controller("api/v1/telematics")
@UseGuards(AuthGuard, RolesGuard)
export class TelematicsController {
  constructor(private readonly telematics: TelematicsService) {}

  /**
   * Authenticated batch ingestion (ADR-0029 commitment 10). Accepts
   * `{ pings: [ ... ] }` (a single ping is the batch-of-one), validates
   * minimally via ZodValidationPipe (coordinate ranges, cuid ids, ISO
   * timestamp, `.strict()` unknown-key rejection → HTTP 400), enqueues onto
   * `gps-ingest`, and RETURNS FAST with 202 — it does NOT block on the
   * database write (the worker bulk-inserts asynchronously).
   *
   * Gated by `@RequirePermission("gps:ingest")` (ADMIN-held today, ADR-0029
   * commitment 11) on top of the composed AuthGuard + RolesGuard chain.
   *
   * `createdById` is taken from `request.session.user.id` (ADR-0021) and
   * travels in the job payload — it is NEVER read from the body, which the
   * schema's `.strict()` rejects.
   */
  @Post("pings")
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission("gps:ingest")
  async ingest(
    @Body(new ZodValidationPipe(IngestBatchSchema)) body: IngestBatchInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<IngestAck> {
    const { jobId, accepted } = await this.telematics.enqueueBatch(
      body.pings,
      request.session.user.id,
    );
    return { accepted, jobId };
  }

  /**
   * RAW trace read (ADR-0027 c7 / ADR-0029 c11) — `gps:read-raw`, ADMIN-only,
   * the most-privileged operational data access in the system. List a
   * vehicle's full-resolution pings, time-bounded by `from`/`to` and
   * paginated. Returns the native Float coordinates + movement + timestamp via
   * Prisma-native reads (RAW_PING_SELECT — never the geometry column).
   *
   * The Tier-5 coordinates travel to the ADMIN caller over the wire (that IS
   * the raw-trace export) but are never logged (pino redact) and never enter a
   * span — the egress discipline holds on reads exactly as on ingest.
   */
  @Get("vehicles/:vehicleId/pings")
  @RequirePermission("gps:read-raw")
  async listPings(
    @Param("vehicleId") vehicleId: string,
    @Query(new ZodValidationPipe(ListPingsQuerySchema)) query: ListPingsQuery,
  ): Promise<RawPingsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: PingSortColumn = query.sortBy ?? "timestamp";
    const sortDir: PingSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.telematics.listRawPings({
      vehicleId,
      skip,
      take,
      from: query.from,
      to: query.to,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * DERIVED live location (ADR-0027 c7) — `gps:read-derived`, ADMIN +
   * OFFICE_STAFF. The single latest fix for the live-location map (NOT the
   * trail). `fix` is null when the vehicle has no ping.
   */
  @Get("vehicles/:vehicleId/location")
  @RequirePermission("gps:read-derived")
  async latestLocation(@Param("vehicleId") vehicleId: string): Promise<VehicleLocationResponse> {
    const fix = await this.telematics.latestLocation(vehicleId);
    return { vehicleId, fix };
  }

  /**
   * DERIVED geofence status (ADR-0027 c6 / ADR-0029 c13) — `gps:read-derived`,
   * ADMIN + OFFICE_STAFF. The FIRST PostGIS geofencing: classify the vehicle's
   * latest fix as inside/outside a caller-parameterized geofence (a circle via
   * ST_DWithin, or a polygon via ST_Contains — see TelematicsService). Returns
   * a single boolean (+ the fix time, NOT coordinates) — a Tier-3 derived
   * status, kept genuinely lower-resolution than the raw trail.
   */
  @Get("vehicles/:vehicleId/geofence-status")
  @RequirePermission("gps:read-derived")
  async geofenceStatus(
    @Param("vehicleId") vehicleId: string,
    @Query(new ZodValidationPipe(GeofenceStatusQuerySchema)) query: GeofenceStatusQuery,
  ): Promise<GeofenceStatusResponse> {
    const geofence = toGeofenceQuery(query);
    const { inside, latestFixAt } = await this.telematics.geofenceStatus(vehicleId, geofence);
    return { vehicleId, geofence: describeGeofence(geofence), inside, latestFixAt };
  }
}
