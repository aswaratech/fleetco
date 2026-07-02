import { z } from "zod";

import { type GpsPingInput } from "./telematics.schemas";

// Traccar position-forward contract (ADR-0042 c4/c6, ticket M5). Traccar's
// `forward.type=json` POSTs ONE decoded position per request as
// `{ position: {...}, device: {...} }`.
//
// DELIBERATE, DOCUMENTED DEVIATION from the house `.strict()` rule: these are
// LOOSE objects (unknown keys pass). FleetCo does not own Traccar's contract —
// its payload grows fields across versions and per protocol (`attributes` is
// an open bag) — and a `.strict()` schema would turn a routine Traccar
// upgrade into an ingest outage. Strictness lives one step later instead: the
// MAPPED ping is re-validated through the house IngestBatchSchema bounds
// before anything is enqueued (TraccarIngestService), so tolerance at this
// boundary never becomes tolerance in the pipeline.
//
// Only the fields the mapper consumes are declared; everything else flows
// past. `fixTime` (the device fix instant) is REQUIRED — a position without a
// fix time is not a fix. `valid` is Traccar's own GPS-validity flag;
// `valid: false` positions are dropped upstream of mapping.
export const TraccarForwardSchema = z.object({
  position: z.looseObject({
    latitude: z.number(),
    longitude: z.number(),
    altitude: z.number().nullable().optional(),
    // Traccar stores and forwards speed in KNOTS (its internal/API unit,
    // regardless of display settings) — the mapper converts to the house m/s.
    speed: z.number().nullable().optional(),
    // Course over ground in degrees — the house column calls it `heading`.
    course: z.number().nullable().optional(),
    valid: z.boolean().nullable().optional(),
    fixTime: z.iso.datetime({
      offset: true,
      error: () => "fixTime must be an ISO 8601 datetime.",
    }),
    attributes: z
      .looseObject({
        ignition: z.boolean().optional(),
      })
      .optional(),
  }),
  device: z.looseObject({
    // The IMEI — how Traccar (and the tracker protocol itself) identifies the
    // unit, and how the adapter resolves the vehicle via TrackerDevice.
    uniqueId: z.string().min(1),
  }),
});

export type TraccarForward = z.infer<typeof TraccarForwardSchema>;

// Knots → metres per second (Traccar's speed unit → the GpsPing column unit).
export const KNOTS_TO_MS = 0.514444;

// The bounds the house PingSchema enforces on the OPTIONAL movement fields.
// A single corrupt ATTRIBUTE must not cost the whole fix: a speed or course
// outside these bounds (a unit mistake, a protocol quirk) is OMITTED from the
// mapped ping rather than failing it — whereas a corrupt COORDINATE fails the
// downstream re-validation and drops the fix, which is right (a fix IS its
// coordinates).
const SPEED_MS_MAX = 200;
const HEADING_MAX = 360;
const ALTITUDE_MIN = -1000;
const ALTITUDE_MAX = 20000;

/**
 * Map a validated Traccar forward into the house wire-ping shape (pure,
 * unit-tested): knots → m/s, `course` → `heading`, `attributes.ignition` →
 * `ignition`, `fixTime` → `timestamp` (kept as the ISO string the job payload
 * carries). `tripId` is deliberately ABSENT — hardware pings are not
 * trip-bound (ADR-0042 c8; trip-correlation is a later derived feature).
 */
export function mapTraccarPosition(forward: TraccarForward, vehicleId: string): GpsPingInput {
  const { position } = forward;

  const speedMs =
    position.speed === null || position.speed === undefined
      ? undefined
      : position.speed * KNOTS_TO_MS;
  const heading =
    position.course === null || position.course === undefined ? undefined : position.course;
  const altitude =
    position.altitude === null || position.altitude === undefined ? undefined : position.altitude;
  const ignition = position.attributes?.ignition;

  return {
    vehicleId,
    latitude: position.latitude,
    longitude: position.longitude,
    ...(altitude !== undefined && altitude >= ALTITUDE_MIN && altitude <= ALTITUDE_MAX
      ? { altitude }
      : {}),
    ...(speedMs !== undefined && speedMs >= 0 && speedMs <= SPEED_MS_MAX ? { speed: speedMs } : {}),
    ...(heading !== undefined && heading >= 0 && heading <= HEADING_MAX ? { heading } : {}),
    ...(ignition !== undefined ? { ignition } : {}),
    timestamp: position.fixTime,
  };
}
