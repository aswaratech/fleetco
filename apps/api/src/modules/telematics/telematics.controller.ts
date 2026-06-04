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
import { type GeofenceType } from "@prisma/client";

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
  type ResolvedGeofence,
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
// whole ring — enough context without bloating the response. The stored case
// (ADR-0030 G5) echoes the resolved fence's id + type (both Tier-3 config) so a
// caller passing `geofenceId` sees WHICH stored fence was evaluated — but never
// its coordinates (Tier-5 egress discipline holds on the derived read).
export type GeofenceEcho =
  | { kind: "circle"; centerLatitude: number; centerLongitude: number; radiusMeters: number }
  | { kind: "polygon"; vertexCount: number }
  | { kind: "stored"; geofenceId: string; type: GeofenceType };

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

// Narrow the validated geofence-status query (circle XOR polygon XOR
// geofenceId, guaranteed by the schema's three-way superRefine) into the
// service's GeofenceQuery union. The explicit field checks avoid a non-null
// assertion and keep the function total — the throw is unreachable after the
// refine but fails closed if it drifts. geofenceId is checked first; the refine
// guarantees the modes are mutually exclusive, so order does not affect output.
function toGeofenceQuery(query: GeofenceStatusQuery): GeofenceQuery {
  if (query.geofenceId !== undefined) {
    return { kind: "stored", geofenceId: query.geofenceId };
  }
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
  throw new BadRequestException("A geofence (circle, polygon, or geofenceId) is required.");
}

// Build the safe-to-echo geofence descriptor for the response. For a stored
// fence the descriptor is the resolved row's id + type, which the SERVICE
// loaded (it returns `resolved` on the stored path, or 404s a missing id), so
// `resolved` is non-null whenever `geofence.kind === "stored"`; the guard fails
// closed if that contract ever drifts rather than echo a half-built descriptor.
function describeGeofence(
  geofence: GeofenceQuery,
  resolved: ResolvedGeofence | null,
): GeofenceEcho {
  switch (geofence.kind) {
    case "circle":
      return {
        kind: "circle",
        centerLatitude: geofence.centerLatitude,
        centerLongitude: geofence.centerLongitude,
        radiusMeters: geofence.radiusMeters,
      };
    case "polygon":
      return { kind: "polygon", vertexCount: geofence.vertexCount };
    case "stored":
      if (!resolved) {
        throw new BadRequestException("Stored geofence could not be resolved.");
      }
      return { kind: "stored", geofenceId: resolved.id, type: resolved.type };
  }
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
   * DERIVED geofence status (ADR-0027 c6 / ADR-0029 c13 / ADR-0030 G5) —
   * `gps:read-derived`, ADMIN + OFFICE_STAFF. The FIRST PostGIS geofencing:
   * classify the vehicle's latest fix as inside/outside a geofence supplied as
   * a circle (ST_DWithin), a polygon (ST_Contains), or a STORED fence by
   * `geofenceId` (the service loads it and 404s a missing id) — see
   * TelematicsService. Returns a single boolean (+ the fix time, NOT
   * coordinates) — a Tier-3 derived status, kept genuinely lower-resolution
   * than the raw trail. On the geofenceId path the response also echoes the
   * resolved fence's id + type (Tier-3 config), never its coordinates.
   *
   * The gate stays `gps:read-derived`: this reads geofence STATUS (a derived
   * boolean), NOT the geofence CONFIG, so it is emphatically not `geofences:*`.
   */
  @Get("vehicles/:vehicleId/geofence-status")
  @RequirePermission("gps:read-derived")
  async geofenceStatus(
    @Param("vehicleId") vehicleId: string,
    @Query(new ZodValidationPipe(GeofenceStatusQuerySchema)) query: GeofenceStatusQuery,
  ): Promise<GeofenceStatusResponse> {
    const geofence = toGeofenceQuery(query);
    const { inside, latestFixAt, resolvedGeofence } = await this.telematics.geofenceStatus(
      vehicleId,
      geofence,
    );
    return {
      vehicleId,
      geofence: describeGeofence(geofence, resolvedGeofence),
      inside,
      latestFixAt,
    };
  }
}
