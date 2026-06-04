import { z } from "zod";

import { PolygonParam, type ParsedPolygon } from "../../common/wkt";

// Zod schemas for the telematics ingestion slice (ADR-0029 T3, commitment
// 10). The authenticated batch endpoint does MINIMAL validation and then
// enqueues onto `gps-ingest` — it deliberately does NOT block on the database
// write (the worker does the bulk insert). So these schemas validate only the
// shape and the obviously-corrupt-value cases (out-of-range coordinates, a
// non-cuid id, a non-ISO timestamp); FK existence is NOT checked here (that
// would need a DB round-trip and defeat the fast return) — a stale FK surfaces
// as a failed worker job in BullMQ's `failed` set, not as a synchronous 4xx
// (there is no synchronous client to return it to once the 202 is sent).
//
// Mirrors the `.strict()` discipline and the `Cuid` helper of
// apps/api/src/modules/fuel-logs/fuel-logs.schemas.ts: a typo'd or
// server-controlled key (notably `createdById`, which the controller fills
// from the authenticated session per ADR-0021, NEVER from the body) surfaces
// as HTTP 400 rather than being silently accepted.
//
// ──────────────────────────────────────────────────────────────────────────
// BATCH SHAPE DECISION (ADR-0029 commitment 10 left the exact shape to the
// code slice): a wrapper object `{ pings: [ ... ] }` whose every ping carries
// its OWN `vehicleId`, NOT a batch-level `vehicleId` applied to all.
//
//   • Per-ping `vehicleId` (not batch-level) is the minimal, schema-faithful
//     shape: the `GpsPing` row itself has a per-row `vehicleId` (T2), so a
//     per-ping id maps 1:1 to the column with no denormalize/merge step, and
//     the degenerate batch-of-one is just a one-element array. A batch-level
//     id would be an optimization for the common "one device = one vehicle per
//     flush" case, but it bakes in a coupling assumption the not-yet-built
//     driver app may not want; the driver-app slice can add a batch-level
//     default later as a refinement without breaking this per-ping contract.
//   • A wrapper OBJECT `{ pings: [...] }` (not a bare top-level array) so the
//     payload is `.strict()`-checkable (a bare array cannot reject unknown
//     sibling keys) and is extensible — a future batch-level field (a device
//     id, a flush timestamp) is an added key, not a breaking reshape.
// ──────────────────────────────────────────────────────────────────────────

// cuid shape for the FK ids, identical to the fuel-logs write-path `Cuid`
// helper: loose enough to accept any Prisma `cuid()` without the false
// rejections zod's strict `.cuid()` produces on some toolchain versions, tight
// enough to keep query-string / body garbage out. A stale-but-cuid-shaped id
// slips through to the worker and fails the insert (FK violation) there.
const Cuid = z
  .string()
  .trim()
  .min(1, "Required.")
  .regex(/^c[a-z0-9]{8,}$/i, "Must be a valid id.");

// Coordinate bounds. Latitude/longitude are the hard WGS84 ranges (ADR-0029
// kickoff): a value outside them is not a location, it is corruption. They are
// the canonical Prisma-native Float columns; the generated geometry derives
// from them in the database (T2).
const Latitude = z
  .number({ error: () => "latitude must be a number." })
  .min(-90, "latitude must be between -90 and 90.")
  .max(90, "latitude must be between -90 and 90.");

const Longitude = z
  .number({ error: () => "longitude must be a number." })
  .min(-180, "longitude must be between -180 and 180.")
  .max(180, "longitude must be between -180 and 180.");

// Movement bounds are defensive, not precise — generous enough never to reject
// a legitimate fix, tight enough to catch a units mistake or a corrupt value.
// altitude in meters (Everest is ~8849 m; a few thousand metres of GPS error
// headroom above that, and below sea level for the rare depression), speed in
// m/s (200 m/s ≈ 720 km/h, far above any truck — a value above it is almost
// certainly km/h pasted into an m/s field), heading in degrees (0–360, 360
// allowed because some devices report a full turn as 360 rather than 0).
const Altitude = z
  .number({ error: () => "altitude must be a number." })
  .min(-1000, "altitude must be between -1000 and 20000 metres.")
  .max(20000, "altitude must be between -1000 and 20000 metres.");

const Speed = z
  .number({ error: () => "speed must be a number." })
  .min(0, "speed must be between 0 and 200 m/s.")
  .max(200, "speed must be between 0 and 200 m/s.");

const Heading = z
  .number({ error: () => "heading must be a number." })
  .min(0, "heading must be between 0 and 360 degrees.")
  .max(360, "heading must be between 0 and 360 degrees.");

// `timestamp` is validated as an ISO-8601 datetime STRING and stays a string
// end-to-end. It is deliberately NOT coerced to a `Date` at the boundary
// (unlike the synchronous fuel-logs `date`): the validated batch is
// JSON-serialized into a BullMQ job in Redis, where a `Date` would become a
// string anyway and deserialize as a string in the worker — typing it as
// `Date` would be a latent lie. The worker maps it to `new Date(...)` for the
// Prisma `DateTime` column. `{ offset: true }` accepts both `Z` and a numeric
// offset such as Nepal's `+05:45`, since a device may stamp local-with-offset.
const Timestamp = z.iso.datetime({
  offset: true,
  error: () => "timestamp must be an ISO 8601 datetime (e.g. 2026-02-15T08:00:00Z).",
});

// One GPS fix. `.strict()` rejects unknown keys — including the
// server-controlled `createdById` (filled from the session, ADR-0021) and the
// database-derived `geometry` / `id` / `createdAt` (never client-supplied).
const PingSchema = z
  .object({
    vehicleId: Cuid,
    tripId: Cuid.nullable().optional(),
    latitude: Latitude,
    longitude: Longitude,
    altitude: Altitude.nullable().optional(),
    speed: Speed.nullable().optional(),
    heading: Heading.nullable().optional(),
    timestamp: Timestamp,
  })
  .strict();

export type GpsPingInput = z.infer<typeof PingSchema>;

// Batch bounds. min 1 — an empty batch is a no-op that should never be
// enqueued (reject at the boundary rather than spend a job on nothing). max
// 1000 — a generous ceiling for a driver-app flush of buffered background
// locations; it bounds the per-job insert size (and the Redis job payload) so
// one request cannot enqueue an unbounded write. The cap is explicit and
// per-ADR-0029-"Revisit when" tunable against measured fleet volume.
const BATCH_MIN = 1;
const BATCH_MAX = 1000;

/**
 * POST /api/v1/telematics/pings body schema: `{ pings: [ ...fixes ] }`.
 * A single ping is the degenerate batch-of-one (`{ pings: [ <fix> ] }`).
 * `.strict()` on the wrapper rejects any sibling key so the shape can grow
 * additively (a batch-level field) without silently accepting today's typos.
 */
export const IngestBatchSchema = z
  .object({
    pings: z
      .array(PingSchema)
      .min(BATCH_MIN, "A batch must contain at least one ping.")
      .max(BATCH_MAX, `A batch must contain at most ${BATCH_MAX} pings.`),
  })
  .strict();

export type IngestBatchInput = z.infer<typeof IngestBatchSchema>;

// ──────────────────────────────────────────────────────────────────────────
// READ-PATH SCHEMAS (ADR-0029 T5) — the RBAC-gated raw/derived read split.
//
// Two query schemas mirror the established Phase-1 list-endpoint conventions
// (fuel-logs.schemas.ts): a `.strict()` object that rejects typo'd keys with
// HTTP 400, coerced-and-bounded pagination, and a sortable-column whitelist
// (never an arbitrary `orderBy` column). The vehicle is a PATH param on the
// read routes (`/vehicles/:vehicleId/...`), not a query filter — so it does
// not appear in these query schemas (the same way fuel-logs' `:id` is a path
// param, not validated by the list query schema). An unknown vehicleId yields
// an empty result set / null fix, the same survives-a-stale-referent UX the
// fuel-logs list documents.
// ──────────────────────────────────────────────────────────────────────────

// Coerce a string query param to a non-negative integer with bounds. Same
// shape as the fuel-logs `intParam` — out-of-range values 400 with a clear
// message rather than being silently clamped (a deliberate `take=10000`
// clamped to 200 would surprise an API consumer).
function intParam(min: number, max: number, fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be an integer.` });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${min} or greater.` });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${max} or less.` });
        return z.NEVER;
      }
      return n;
    });
}

// `from` / `to` date-range filters on the ping `timestamp` (inclusive bounds at
// the service layer, gte / lte). `z.coerce.date()` accepts YYYY-MM-DD and ISO
// 8601; an invalid value fails the parse → 400.
const TimestampFilter = z.coerce
  .date({ error: () => "Must be a valid date (YYYY-MM-DD or ISO 8601)." })
  .optional();

// ── Raw trace list (gps:read-raw, ADMIN-only) ──
//
// The full-resolution raw trace of one vehicle — the most-privileged
// operational data access in the system (ADR-0027 c7). Paginated and
// time-bounded so the highest-row-count table in the system is never queried
// unbounded.

// Sortable columns: `timestamp` (the device fix time — default, "most recent
// fix first", served cheaply by the `(timestamp desc)` index) and `createdAt`
// (storage time). Whitelisted, never arbitrary — the same defense the
// fuel-logs / trips / jobs schemas document (an arbitrary `sortBy=latitude`
// would both invite expensive sorts and leak Tier-5 ordering signal).
const PING_SORTABLE_COLUMNS = ["timestamp", "createdAt"] as const;
export type PingSortColumn = (typeof PING_SORTABLE_COLUMNS)[number];

const PING_SORT_DIRECTIONS = ["asc", "desc"] as const;
export type PingSortDir = (typeof PING_SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from telematics.service.ts on purpose: the
// service is the runtime authority (defense-in-depth), the schema validates
// only what the client sent. Both move together when one changes — the same
// coupling fuel-logs.schemas.ts documents.
const PINGS_QUERY_MAX_TAKE = 200;

/**
 * GET /api/v1/telematics/vehicles/:vehicleId/pings query schema. `.strict()`
 * so a typo'd key (`?form=...`) surfaces as 400 rather than being ignored.
 */
export const ListPingsQuerySchema = z
  .object({
    from: TimestampFilter,
    to: TimestampFilter,
    sortBy: z.enum(PING_SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(PING_SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, PINGS_QUERY_MAX_TAKE, "take"),
  })
  .strict();

export type ListPingsQuery = z.infer<typeof ListPingsQuerySchema>;

// ── Geofence status (gps:read-derived, ADMIN + OFFICE_STAFF) ──
//
// A parameterized geofence check over the vehicle's LATEST fix — a single
// boolean ("is the vehicle inside this geofence right now?"), the derived,
// genuinely-lower-resolution product ADR-0027 c6/c7 keeps on the OFFICE_STAFF
// side of the raw-vs-derived split (NOT the full trail relabeled, which the
// anti-circumvention clause keeps Tier 5). Two mutually-exclusive geofence
// shapes, exactly one per request (the superRefine enforces it):
//
//   • CIRCLE  — centerLatitude + centerLongitude + radiusMeters → ST_DWithin
//     (meter-accurate via a geography cast; see the service).
//   • POLYGON — a vertex list `lon,lat;lon,lat;lon,lat` (≥3) → ST_Contains.
//
// Geofence-polygon STORAGE (a `geometry(Polygon, 4326)` company-configuration
// aggregate, Tier 3 per ADR-0027 c6) is DEFERRED to its own sibling slice — it
// needs its own design (depot / customer-site / route-corridor types, naming,
// a management surface) and would balloon this read slice. T5 demonstrates
// geofencing against a geofence the caller PARAMETERIZES per request; the
// query is identical once a stored-polygon slice supplies the geometry from a
// row instead of a query param. (Said explicitly in the PR description.)

// A coerced finite coordinate/number query param with bounds. Like `intParam`
// but accepts decimals (coordinates are not integers). A present-but-empty
// value (`?centerLatitude=`) is an error, not a silent skip.
function coordParam(min: number, max: number, fieldLabel: string) {
  return z
    .string()
    .trim()
    .transform((raw, ctx): number => {
      if (raw === "") {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} is required.` });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be a number.` });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${min} or greater.` });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${max} or less.` });
        return z.NEVER;
      }
      return n;
    });
}

// Proximity radius bounds, meters. Floor 1 m (a 0 m geofence is a corrupt
// request); ceiling 500 km — absurdly generous for a depot/site/corridor,
// tight enough to catch a units mistake (a degree value pasted into a meters
// field). ST_DWithin reads this as meters because the service casts to
// geography (see the geometry-vs-geography note there).
const RADIUS_METERS_MIN = 1;
const RADIUS_METERS_MAX = 500_000;

// ── Geofence vertex parser (shared) ──
//
// The `lon,lat;…` → closed `POLYGON((…))` WKT builder and its `ParsedPolygon`
// result now live in the shared `common/wkt` module. It was extracted there
// (ADR-0030 G2) so the stored Geofence aggregate (ADR-0030) and this
// caller-parameterized T5 query build WKT from the SAME code — the
// representation-coherence guarantee (ADR-0030 commitment 1): a stored fence
// and an ad-hoc query-param fence are byte-identical WKT and classify
// identically. Two copies WOULD drift; one source makes the guarantee
// structural. Re-exported here so any existing importer of this file keeps its
// import path, and `GeofenceStatusQuerySchema` below consumes the same binding.
export { PolygonParam };
export type { ParsedPolygon };

/**
 * GET /api/v1/telematics/vehicles/:vehicleId/geofence-status query schema.
 * Provide EITHER a circle (centerLatitude + centerLongitude + radiusMeters) OR
 * a polygon (`polygon=lon,lat;lon,lat;lon,lat`) — exactly one. `.strict()`
 * rejects typo'd keys; the superRefine rejects "both", "neither", and a
 * partial circle, each with a 400 naming what is wrong.
 */
export const GeofenceStatusQuerySchema = z
  .object({
    centerLatitude: coordParam(-90, 90, "centerLatitude").optional(),
    centerLongitude: coordParam(-180, 180, "centerLongitude").optional(),
    radiusMeters: coordParam(RADIUS_METERS_MIN, RADIUS_METERS_MAX, "radiusMeters").optional(),
    polygon: PolygonParam.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasAnyCircle =
      data.centerLatitude !== undefined ||
      data.centerLongitude !== undefined ||
      data.radiusMeters !== undefined;
    const hasFullCircle =
      data.centerLatitude !== undefined &&
      data.centerLongitude !== undefined &&
      data.radiusMeters !== undefined;
    const hasPolygon = data.polygon !== undefined;

    if (hasPolygon && hasAnyCircle) {
      ctx.addIssue({
        code: "custom",
        message: "Provide either a circle (center + radius) or a polygon, not both.",
      });
      return;
    }
    if (!hasPolygon && !hasAnyCircle) {
      ctx.addIssue({
        code: "custom",
        message:
          "Provide a geofence: a circle (centerLatitude, centerLongitude, radiusMeters) or a polygon (lon,lat;lon,lat;lon,lat).",
      });
      return;
    }
    if (hasAnyCircle && !hasFullCircle) {
      ctx.addIssue({
        code: "custom",
        message: "A circle geofence needs centerLatitude, centerLongitude, and radiusMeters.",
      });
    }
  });

export type GeofenceStatusQuery = z.infer<typeof GeofenceStatusQuerySchema>;
