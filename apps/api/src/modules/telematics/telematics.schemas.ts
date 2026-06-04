import { z } from "zod";

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
