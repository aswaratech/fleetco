import { InjectQueue } from "@nestjs/bullmq";
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  TripStatus,
  type GeofenceType,
  type Prisma,
  type VehicleKind,
  type VehicleStatus,
} from "@prisma/client";
import { type Queue } from "bullmq";

import { type GpsPingInput, type PingSortColumn, type PingSortDir } from "./telematics.schemas";

// PrismaService is injected by NestJS via emitDecoratorMetadata (see
// apps/api/tsconfig.json); the class reference must remain a value import at
// runtime so the DI container can resolve it. Same eslint override as every
// other vertical-slice service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// GeofencesService is injected to resolve a STORED fence by id in the G5
// geofence-status wiring (ADR-0030 G5). It is the geofence aggregate's PUBLIC
// service interface — GeofencesModule exports it for exactly this consumer
// (its export comment names the G5 wiring), so reading a stored fence goes
// through the module boundary rather than reaching into the geofence table
// directly (CLAUDE.md §"talk through public service interfaces"). Imported as a
// runtime value for DI, same eslint override as PrismaService above.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { GeofencesService } from "../geofences/geofences.service";

// DriverScopeService supplies the D4 own-record predicate's driver resolution
// (ADR-0034 c4/c5) — the auth module's PUBLIC export for exactly this class of
// consumer (TelematicsModule already imports AuthModule). Injected as a runtime
// value, same eslint override as PrismaService above; `Actor` rides along as a
// type-only specifier.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { DriverScopeService, type Actor } from "../auth/driver-scope.service";

// The named queue this feature owns (ADR-0029 commitment 2: per-feature queue
// ownership — the root config lives in the @Global() QueueModule from T1, but
// the `gps-ingest` queue is registered and owned HERE, by the telematics
// feature that produces and consumes it). Exported so the producer
// (@InjectQueue), the worker (@Processor in gps-ingest.processor.ts), and the
// module (BullModule.registerQueue) all name the SAME string — a typo would
// otherwise wire a producer to one queue and a worker to another with no
// compile error.
export const GPS_INGEST_QUEUE = "gps-ingest";

// The job name within the queue. One job = one batch (ADR-0026 commitment 4:
// the batch is the unit, not the ping).
export const GPS_INGEST_JOB_NAME = "ingest-batch";

// Worker concurrency for the ingest queue (ADR-0029 commitment 5: "the ingest
// worker tuned to its batch size"). Each job is a single bulk `createMany`, so
// a handful of concurrent jobs gives throughput without flooding the Prisma
// connection pool with parallel large inserts. 4 is a deliberate, modest
// default that is overridable per the ADR's "Revisit when" once real fleet
// volume is measured — it is sized against assumption, not load (ADR-0029
// "Costs we accept").
export const GPS_INGEST_CONCURRENCY = 4;

// The job payload that travels through Redis from the producer (the endpoint)
// to the consumer (the worker). It carries the validated batch plus the
// `createdById` resolved from the authenticated session (ADR-0021) — the body
// never supplies `createdById` (the schema's `.strict()` rejects it), so it
// rides alongside the pings here rather than inside each one. Note `pings`
// carry `timestamp` as the validated ISO STRING (not a Date): BullMQ
// JSON-serializes this object into Redis, so a Date would be a string on the
// other side anyway — the worker maps it to `new Date(...)` at insert time.
export interface GpsIngestJobData {
  createdById: string;
  pings: GpsPingInput[];
}

// ──────────────────────────────────────────────────────────────────────────
// READ PATH (ADR-0029 T5) — the RBAC-gated raw/derived read split.
// ──────────────────────────────────────────────────────────────────────────

// Pagination defaults/bounds for the raw trace list — same `LIST_TAKE_` prefix
// and 200 ceiling every Phase-1 list service uses. The clamp in `listRawPings`
// is defense-in-depth: the controller validates `take` against the same
// ceiling, but a future in-process caller could reach the service directly.
export const LIST_TAKE_DEFAULT = 50;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// RAW trace projection (gps:read-raw). The native Float `latitude`/`longitude`
// + movement + `timestamp` + FK/audit columns, read NATIVELY by Prisma. It
// deliberately NEVER selects the `geometry` column — Prisma cannot select an
// Unsupported type, and the generated GpsPing client type does not even expose
// it, so `geometry: true` would not type-check. This is the type-safe hot path
// the hybrid representation (ADR-0029 c8) keeps off raw SQL; spatial SQL is
// confined to `geofenceStatus` below. Tier-5 coordinates DO travel to the
// ADMIN caller over the wire (that is the raw-trace export, ADR-0027 c7), but
// they never log (pino redact denylists the GPS keys) and never enter a span.
const RAW_PING_SELECT = {
  id: true,
  vehicleId: true,
  tripId: true,
  latitude: true,
  longitude: true,
  altitude: true,
  speed: true,
  heading: true,
  timestamp: true,
  createdAt: true,
  createdById: true,
} satisfies Prisma.GpsPingSelect;

export type RawPingItem = Prisma.GpsPingGetPayload<{ select: typeof RAW_PING_SELECT }>;

export interface RawPingsResult {
  items: RawPingItem[];
  total: number;
}

// DERIVED live-location projection (gps:read-derived). The SINGLE latest fix —
// a current position for the live-location map (ADR-0027 c7's derived view),
// NOT the full trail. A single current point is genuinely lower-resolution
// than the raw trace and so stays on the OFFICE_STAFF side of the
// raw-vs-derived split; the anti-circumvention clause (ADR-0027 c6) keeps a
// dense trail Tier 5, which is exactly why this returns ONE fix, not a list.
const LOCATION_SELECT = {
  latitude: true,
  longitude: true,
  altitude: true,
  speed: true,
  heading: true,
  timestamp: true,
} satisfies Prisma.GpsPingSelect;

export type LocationFix = Prisma.GpsPingGetPayload<{ select: typeof LOCATION_SELECT }>;

// FLEET-WIDE latest-positions projection (gps:read-derived) — the live map's
// poll target (ADR-0042 c10, ticket M7). One latest fix per NON-RETIRED
// vehicle (never trails — ADR-0027 c6 keeps a dense trail Tier 5; this is the
// per-vehicle `latestLocation` derived view widened to the fleet), plus a
// SERVER-computed `fixAgeSeconds` so the map's staleness treatment never
// trusts a client clock. Vehicles with no fix appear with `fix: null`
// (absence-of-data is data — the DESIGN.md §Live map untracked list).
export interface LatestPositionFix {
  latitude: number;
  longitude: number;
  speed: number | null;
  heading: number | null;
  ignition: boolean | null;
  timestamp: Date;
}

export interface LatestPosition {
  vehicleId: string;
  registrationNumber: string;
  kind: VehicleKind;
  status: VehicleStatus;
  fix: LatestPositionFix | null;
  fixAgeSeconds: number | null;
}

// The flat row the SQL below returns; latestPositions() folds it into the
// nested LatestPosition shape (a LEFT-JOIN miss leaves every fix column null).
interface LatestPositionRow {
  vehicleId: string;
  registrationNumber: string;
  kind: VehicleKind;
  status: VehicleStatus;
  latitude: number | null;
  longitude: number | null;
  speed: number | null;
  heading: number | null;
  ignition: boolean | null;
  timestamp: Date | null;
  fixAgeSeconds: number | null;
}

// A geofence to classify the vehicle's LATEST fix against. THREE kinds:
//   • circle  — proximity (ST_DWithin), caller-parameterized per request.
//   • polygon — containment (ST_Contains), caller-parameterized per request;
//     the `wkt` is built by the schema from validated finite numbers.
//   • stored  — a STORED Geofence by id (ADR-0030 G5). The service loads the
//     row, reads its canonical `boundaryWkt`, and runs the SAME ST_Contains
//     query as the polygon kind — the boundaryWkt is byte-identical to what a
//     query-param polygon produces for the same vertices (the shared
//     common/wkt builder, ADR-0030 commitment 1's coherence guarantee), so the
//     spatial query body is unchanged; only the WKT's SOURCE differs (a stored
//     row vs a query param).
// Every value reaches Postgres bound as a `$queryRaw` parameter, never
// string-interpolated.
export type GeofenceQuery =
  | { kind: "circle"; centerLatitude: number; centerLongitude: number; radiusMeters: number }
  | { kind: "polygon"; wkt: string; vertexCount: number }
  | { kind: "stored"; geofenceId: string };

// The stored fence echoed back when a `geofenceId` was supplied: its id + type
// only (both Tier-3 config, ADR-0027 c6) — NEVER the boundary coordinates, so
// the derived status egresses a boolean + timestamp + the fence's own id/type,
// and nothing finer.
export interface ResolvedGeofence {
  id: string;
  type: GeofenceType;
}

// Geofence status of the vehicle's LATEST fix: a boolean (null when the
// vehicle has no ping) plus the fix time it was evaluated against (the
// timestamp is NOT Tier-5 location data — ADR-0027 c9 — so it is safe to
// return and answers "inside as of when?"). Deliberately carries NO
// coordinates: the spatial `$queryRaw` returns only this boolean + timestamp,
// so even the raw-SQL path egresses no Tier-5 coordinate. `resolvedGeofence` is
// populated ONLY on the stored (`geofenceId`) path so the controller can echo
// WHICH stored fence was evaluated; it is null for the circle/polygon kinds.
export interface GeofenceStatusResult {
  inside: boolean | null;
  latestFixAt: Date | null;
  resolvedGeofence: ResolvedGeofence | null;
}

// The raw row shape `geofenceStatus`'s `$queryRaw` returns: `ST_DWithin` /
// `ST_Contains` yield a Postgres boolean, the aliased `timestamp` a Date.
interface GeofenceStatusRow {
  inside: boolean | null;
  latestFixAt: Date | null;
}

@Injectable()
export class TelematicsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(GPS_INGEST_QUEUE) private readonly queue: Queue<GpsIngestJobData>,
    private readonly geofences: GeofencesService,
    private readonly driverScope: DriverScopeService,
  ) {}

  /**
   * D4's row-level own-record predicate (ADR-0034 c5: a DRIVER write capability
   * enters the capability map ONLY with its scope in the same change; ADR-0035
   * c1's on-trip collection boundary). For a DRIVER actor, every ping in the
   * batch must carry a `tripId`; each distinct trip must be the driver's OWN
   * (`trip.driverId === resolveOwnDriverId(actor)`, via the Driver.userId link)
   * and IN_PROGRESS; and each ping's `vehicleId` must equal its trip's vehicle.
   * The phone producer only ever reports the active trip it is bound to, so
   * anything else is a spoofed or stale payload — ANY violation rejects the
   * WHOLE batch with 403, fail-closed, matching the worker's all-or-nothing
   * `createMany` posture (a partially-accepted batch would lie about what was
   * stored). The bare 403 deliberately hides whether a foreign trip exists
   * (the existence-hiding rule the D2 read paths follow with 404).
   *
   * Non-DRIVER actors return immediately with zero queries — the ADMIN
   * synthetic-ingest path (ADR-0029 c11) is unchanged. The check runs BEFORE
   * enqueue: the worker has no client to answer, so pre-enqueue is the one
   * place a synchronous 403 can exist. The one indexed Driver lookup + one
   * indexed Trip lookup it costs on the driver path is accepted deliberately
   * over the 202-fast micro-optimization — the c5 atomic rule outranks it.
   * An unlinked DRIVER session throws 403 inside resolveOwnDriverId (the D2
   * fail-closed posture).
   */
  async assertDriverCanIngest(actor: Actor, pings: GpsPingInput[]): Promise<void> {
    const ownDriverId = await this.driverScope.resolveOwnDriverId(actor);
    if (ownDriverId === null) {
      return;
    }

    const tripIds = new Set<string>();
    for (const ping of pings) {
      if (!ping.tripId) {
        throw new ForbiddenException("Driver pings must carry the active trip's tripId.");
      }
      tripIds.add(ping.tripId);
    }

    const trips = await this.prisma.trip.findMany({
      where: { id: { in: [...tripIds] } },
      select: { id: true, driverId: true, vehicleId: true, status: true },
    });
    const tripById = new Map(trips.map((trip) => [trip.id, trip]));

    for (const ping of pings) {
      const trip = ping.tripId ? tripById.get(ping.tripId) : undefined;
      if (
        !trip ||
        trip.driverId !== ownDriverId ||
        trip.status !== TripStatus.IN_PROGRESS ||
        trip.vehicleId !== ping.vehicleId
      ) {
        throw new ForbiddenException();
      }
    }
  }

  /**
   * Producer half of the ingestion path (ADR-0029 commitment 10). Enqueue the
   * validated batch onto `gps-ingest` and RETURN FAST — the API thread does
   * NOT block on the database write; the worker (insertBatch, below) does the
   * bulk insert asynchronously. `createdById` comes from the authenticated
   * principal (the controller reads `request.session.user.id`), never from the
   * body. Returns a small acknowledgement (the BullMQ job id for correlation
   * and the count accepted) — the endpoint replies 202 with it; it does not
   * echo the rows, which do not exist yet.
   */
  async enqueueBatch(
    pings: GpsPingInput[],
    createdById: string,
  ): Promise<{ jobId: string | null; accepted: number }> {
    const job = await this.queue.add(GPS_INGEST_JOB_NAME, { createdById, pings });
    return { jobId: job.id ?? null, accepted: pings.length };
  }

  /**
   * Consumer half (ADR-0029 commitment 10), called by the `gps-ingest`
   * worker. Bulk-insert the batch via a single `createMany`.
   *
   * The insert supplies ONLY the native Float columns + FKs + timestamp. The
   * `geometry` column is `GENERATED ALWAYS … STORED` (T2), so the database
   * derives it from latitude/longitude and Prisma must never write it — which
   * it satisfies for free because the Unsupported `geometry` column is absent
   * from `GpsPingCreateManyInput` entirely. `tripId` / `altitude` / `speed` /
   * `heading` default to null when the ping omitted them. `timestamp` is the
   * validated ISO string mapped to a `Date` here.
   *
   * `createMany` issues one all-or-nothing INSERT: if any row violates an FK
   * (a stale `vehicleId` / `tripId` / `createdById`), Postgres rejects the
   * whole batch and the job fails. That is the intended posture for a batch
   * from one device (a consistent set of fixes), and the failure rides
   * BullMQ's bounded retry → `failed`-set dead-letter (the T1 default job
   * options) rather than a synchronous 4xx — the 202 was already sent.
   */
  async insertBatch(data: GpsIngestJobData): Promise<{ count: number }> {
    const rows: Prisma.GpsPingCreateManyInput[] = data.pings.map((ping) => ({
      vehicleId: ping.vehicleId,
      tripId: ping.tripId ?? null,
      latitude: ping.latitude,
      longitude: ping.longitude,
      altitude: ping.altitude ?? null,
      speed: ping.speed ?? null,
      heading: ping.heading ?? null,
      ignition: ping.ignition ?? null,
      timestamp: new Date(ping.timestamp),
      createdById: data.createdById,
    }));

    return this.prisma.gpsPing.createMany({ data: rows });
  }

  /**
   * RAW trace read (gps:read-raw, ADMIN-only — ADR-0027 c7). List one
   * vehicle's full-resolution pings, time-bounded by `from`/`to` (inclusive)
   * and paginated, newest fix first by default. Native Prisma read of the
   * Float columns (RAW_PING_SELECT) — NO geometry, NO raw SQL: the hybrid
   * representation keeps ordinary coordinate reads on the type-safe path.
   *
   * `vehicleId` is the path param, an exact-equality filter; an unknown id
   * yields `{ items: [], total: 0 }` (the same survives-a-stale-referent UX
   * the fuel-logs list documents). `skip`/`take` are clamped to safe bounds as
   * defense-in-depth even though the controller already validated them.
   */
  async listRawPings({
    vehicleId,
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    from,
    to,
    sortBy = "timestamp",
    sortDir = "desc",
  }: {
    vehicleId: string;
    skip?: number;
    take?: number;
    from?: Date;
    to?: Date;
    sortBy?: PingSortColumn;
    sortDir?: PingSortDir;
  }): Promise<RawPingsResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Inclusive `timestamp` range; each bound included only when present so an
    // omitted filter does not generate a noisy `where` clause.
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = from;
    if (to) range.lte = to;
    const hasRange = from !== undefined || to !== undefined;

    const where: Prisma.GpsPingWhereInput = {
      vehicleId,
      ...(hasRange ? { timestamp: range } : {}),
    };

    // Primary sort by the requested column + direction; `id` as a stable
    // tiebreaker so pagination is stable when two fixes share a timestamp
    // (a real case for a batch flushed with identical device times).
    const orderBy: Prisma.GpsPingOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.GpsPingOrderByWithRelationInput,
      { id: sortDir } as Prisma.GpsPingOrderByWithRelationInput,
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.gpsPing.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: RAW_PING_SELECT,
      }),
      this.prisma.gpsPing.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * DERIVED live location (gps:read-derived — ADMIN + OFFICE_STAFF). The single
   * most-recent fix for the vehicle, or null if it has none. Native Prisma
   * read (no raw SQL). This is the "live-location map" derived view ADR-0027
   * c7 puts on the OFFICE_STAFF side of the split — ONE current point, not the
   * trail (which would trip the anti-circumvention clause, ADR-0027 c6).
   */
  async latestLocation(vehicleId: string): Promise<LocationFix | null> {
    return this.prisma.gpsPing.findFirst({
      where: { vehicleId },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      select: LOCATION_SELECT,
    });
  }

  /**
   * FLEET-WIDE latest positions (gps:read-derived) — the live map's ~20 s poll
   * target (ADR-0042 c10, M7). One row per non-retired vehicle (ACTIVE +
   * IN_MAINTENANCE; RETIRED / SOLD are excluded — they are not "the fleet"),
   * LEFT-joined to its single latest fix so untracked / no-fix vehicles appear
   * with `fix: null` rather than silently vanishing from the fleet picture.
   *
   * Raw SQL because Prisma cannot express a per-vehicle top-1 join. The shape
   * is a LEFT JOIN LATERAL … ORDER BY timestamp DESC LIMIT 1 — the join-shaped
   * equivalent of ADR-0042's `DISTINCT ON` sketch, and the form that actually
   * drives from the vehicles side (which the LEFT JOIN needs) — each lateral
   * probe is a single descent of the M3 composite (vehicleId, timestamp DESC)
   * index. The `id DESC` tiebreaker matches `latestLocation` above so the two
   * derived views can never disagree about which same-timestamp fix is
   * "latest".
   *
   * `fixAgeSeconds` is computed SERVER-side (NOW() - timestamp, floored,
   * clamped ≥ 0 against clock skew) so the map's staleness thresholds never
   * depend on a client clock. Tier-5 egress discipline: one fix per vehicle,
   * never the generated geometry column, coordinates go to the authorized
   * caller only (this query logs nothing; the redact/scrub denylists cover the
   * coordinate keys as a backstop). No pagination: the result is bounded by
   * fleet size (one row per vehicle), not by ping volume.
   */
  async latestPositions(): Promise<LatestPosition[]> {
    const rows = await this.prisma.$queryRaw<LatestPositionRow[]>`
      SELECT
        v."id"                 AS "vehicleId",
        v."registrationNumber" AS "registrationNumber",
        v."kind"               AS "kind",
        v."status"             AS "status",
        p."latitude"           AS "latitude",
        p."longitude"          AS "longitude",
        p."speed"              AS "speed",
        p."heading"            AS "heading",
        p."ignition"           AS "ignition",
        p."timestamp"          AS "timestamp",
        CASE
          WHEN p."timestamp" IS NULL THEN NULL
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - p."timestamp"))))::int
        END                    AS "fixAgeSeconds"
      FROM "vehicle" v
      LEFT JOIN LATERAL (
        SELECT gp."latitude", gp."longitude", gp."speed", gp."heading",
               gp."ignition", gp."timestamp"
        FROM "gps_ping" gp
        WHERE gp."vehicleId" = v."id"
        ORDER BY gp."timestamp" DESC, gp."id" DESC
        LIMIT 1
      ) p ON TRUE
      WHERE v."status" NOT IN ('RETIRED', 'SOLD')
      ORDER BY v."registrationNumber" ASC
    `;

    return rows.map((row) => ({
      vehicleId: row.vehicleId,
      registrationNumber: row.registrationNumber,
      kind: row.kind,
      status: row.status,
      fix:
        row.timestamp === null || row.latitude === null || row.longitude === null
          ? null
          : {
              latitude: row.latitude,
              longitude: row.longitude,
              speed: row.speed,
              heading: row.heading,
              ignition: row.ignition,
              timestamp: row.timestamp,
            },
      fixAgeSeconds: row.fixAgeSeconds,
    }));
  }

  /**
   * DERIVED geofence status (gps:read-derived) — the FIRST real PostGIS
   * spatial query in FleetCo (ADR-0029 c13). Classify the vehicle's LATEST fix
   * as inside/outside a geofence, over the generated `geometry(Point, 4326)`
   * column the hybrid representation exists to enable (ADR-0029 c8). Returns a
   * single boolean (+ the fix time) — a genuinely lower-resolution derived
   * product, never the trail.
   *
   * As of ADR-0030 G5 the geofence may be a STORED fence (by `geofenceId`), not
   * only a caller-parameterized circle/polygon: the service loads the fence via
   * the GeofencesService public interface, throws 404 for a missing id, and
   * runs the SAME ST_Contains query against the stored row's `boundaryWkt`
   * (which is byte-identical to a query-param polygon's WKT for the same
   * vertices — the shared common/wkt builder, ADR-0030 c1). On that path it
   * echoes the resolved fence's id + type (in `resolvedGeofence`), never its
   * coordinates. This is the "one-line change" ADR-0029 T5 anticipated.
   *
   * Raw `$queryRaw` is used because the predicate is inherently `ST_*`-shaped
   * (Prisma cannot express it) — exactly the spatial path the hybrid
   * representation confines raw SQL to. Every caller value is bound via the
   * tagged-template `${}` (Prisma sends them as $1, $2, … parameters): the
   * vehicleId, the center lon/lat/radius, and the polygon WKT are PARAMETERS,
   * never string-interpolated, so there is no SQL-injection surface.
   *
   * GEOMETRY vs GEOGRAPHY (the documented choice this ticket calls for):
   *   • CIRCLE → ST_DWithin. An SRID-4326 `geometry` ST_DWithin measures
   *     distance in DEGREES, which is useless for a "within N metres" depot
   *     fence (a degree is ~111 km of latitude and varies with longitude). So
   *     both sides are cast to `::geography`, under which ST_DWithin is
   *     METER-accurate on the WGS84 spheroid — the correct unit for a physical
   *     geofence radius. Index note: the geography cast does not use the
   *     point's `geometry` GIST index, but this query evaluates the predicate
   *     against the SINGLE latest fix (ORDER BY timestamp DESC LIMIT 1, served
   *     by the `(timestamp desc)` index), so there is no spatial scan to
   *     accelerate; a future many-row proximity scan would add a geography
   *     expression index or a degree-based bounding pre-filter.
   *   • POLYGON → ST_Contains, evaluated in the native SRID-4326 `geometry`.
   *     Containment is TOPOLOGICAL (point-in-polygon), so it is correct
   *     regardless of the planar-degree units — no geography cast is needed or
   *     wanted. Both the polygon (from ST_GeomFromText(wkt, 4326)) and the
   *     point are SRID 4326, so they are directly comparable.
   *
   * ST_MakePoint(lon, lat) X,Y = lon,lat order (the PostGIS foot-gun, the same
   * one the generated column and the schema's WKT builder observe). A swap
   * would put latitude where longitude belongs; the service tests seed pings
   * at Kathmandu coordinates and assert inside/outside so a swap fails loudly.
   */
  async geofenceStatus(vehicleId: string, geofence: GeofenceQuery): Promise<GeofenceStatusResult> {
    // CIRCLE → ST_DWithin proximity (meter-accurate via the geography cast).
    // Returns early; resolvedGeofence is null (there is no stored row).
    if (geofence.kind === "circle") {
      const rows = await this.prisma.$queryRaw<GeofenceStatusRow[]>`
        SELECT
          ST_DWithin(
            "geometry"::geography,
            ST_SetSRID(ST_MakePoint(${geofence.centerLongitude}, ${geofence.centerLatitude}), 4326)::geography,
            ${geofence.radiusMeters}
          ) AS inside,
          "timestamp" AS "latestFixAt"
        FROM "gps_ping"
        WHERE "vehicleId" = ${vehicleId}
        ORDER BY "timestamp" DESC, "id" DESC
        LIMIT 1`;
      const row = rows[0];
      return {
        inside: row?.inside ?? null,
        latestFixAt: row?.latestFixAt ?? null,
        resolvedGeofence: null,
      };
    }

    // POLYGON (query-param) or STORED (by id) — both classify with the SAME
    // ST_Contains query over the SAME WKT representation. Resolve the WKT (and,
    // for a stored fence, the id + type to echo) first.
    //
    // STORED (ADR-0030 G5 — the "one-line change" T5 anticipated): load the row
    // through the GeofencesService PUBLIC interface (GeofencesModule exported it
    // for exactly this), 404 if it is gone, and read its canonical
    // `boundaryWkt`. That text is byte-identical to a query-param polygon's WKT
    // for the same vertices (the shared common/wkt builder, ADR-0030 c1), so
    // the spatial query below does NOT change — only the WKT's source does.
    let wkt: string;
    let resolvedGeofence: ResolvedGeofence | null = null;
    if (geofence.kind === "stored") {
      const fence = await this.geofences.findById(geofence.geofenceId);
      if (!fence) {
        throw new NotFoundException(`Geofence ${geofence.geofenceId} not found.`);
      }
      wkt = fence.boundaryWkt;
      resolvedGeofence = { id: fence.id, type: fence.type };
    } else {
      wkt = geofence.wkt;
    }

    const rows = await this.prisma.$queryRaw<GeofenceStatusRow[]>`
      SELECT
        ST_Contains(ST_GeomFromText(${wkt}, 4326), "geometry") AS inside,
        "timestamp" AS "latestFixAt"
      FROM "gps_ping"
      WHERE "vehicleId" = ${vehicleId}
      ORDER BY "timestamp" DESC, "id" DESC
      LIMIT 1`;
    const row = rows[0];
    return { inside: row?.inside ?? null, latestFixAt: row?.latestFixAt ?? null, resolvedGeofence };
  }
}
