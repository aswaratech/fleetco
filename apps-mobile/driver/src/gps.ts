// D4 foreground GPS capture — the PURE half (ADR-0035 c1; resumed 2026-07-10).
// Everything jest touches lives here: wire-ping construction from a location
// fix, batch chunking, and the flush decision. The native shell (task
// definition, start/stop, POST glue) is src/gps-task.ts, which tests never
// import — the ADR-0033 c4 binary-free gate stays native-free.

// Hand-mirrored wire shape of the API's PingSchema (the ADR-0033 c3 recorded
// hand-mirror cost — apps/api/src/modules/telematics/telematics.schemas.ts is
// canonical; keep field-for-field in sync). The server is `.strict()`: an
// extra key is a 400, so `pingFromFix` must emit EXACTLY these keys. `tripId`
// is REQUIRED here although the server schema allows null — the D4 producer is
// trip-bound by definition, and the server's own-trip predicate 403s a DRIVER
// ping without it.
export interface WirePing {
  vehicleId: string;
  tripId: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
  timestamp: string;
}

// The active trip the capture is bound to (ADR-0027 c2: on-trip only).
export interface ActiveTripRef {
  tripId: string;
  vehicleId: string;
}

// The subset of expo-location's LocationObject the builder reads — structural,
// so this module needs no native import (the real LocationObject satisfies it).
export interface FixLike {
  coords: {
    latitude: number;
    longitude: number;
    altitude?: number | null;
    speed?: number | null;
    heading?: number | null;
  };
  timestamp: number; // milliseconds since epoch
}

// PROVISIONAL capture/flush numbers. ADR-0035 ratifies the MECHANICS and
// deliberately pins no numbers — these are the implementing slice's
// documented provisionals (the owner-level-number pattern: the GPS-retention
// window, the due-soon windows), tuned with pilot data later:
//   - a fix at most every CAPTURE_INTERVAL_MS, or every CAPTURE_DISTANCE_M of
//     travel, whichever the OS honors first;
//   - flush at FLUSH_MAX_PINGS buffered fixes or FLUSH_MAX_INTERVAL_MS since
//     the last flush, whichever comes first. The 60s interval cap keeps an
//     on-trip producer comfortably inside the server's 120s freshness-SLI
//     bound (TELEMATICS_FRESH_SECONDS, apps/api/src/common/sli.ts).
export const CAPTURE_INTERVAL_MS = 15_000;
export const CAPTURE_DISTANCE_M = 25;
export const FLUSH_MAX_PINGS = 4;
export const FLUSH_MAX_INTERVAL_MS = 60_000;

// The server's IngestBatchSchema cap (batch max 1000) — mirrored, not imported.
export const BATCH_MAX = 1000;

// Map a device fix onto the wire shape. Out-of-range rider values become null
// rather than being clamped — a clamped value is a lie, and the server's
// defensive bounds (speed 0–200 m/s, heading 0–360°, altitude −1000–20000 m)
// would reject the whole batch on a single corrupt rider. Android reports
// "unknown" speed/heading as -1: also null. The fix timestamp (ms epoch)
// becomes the ISO string the schema validates.
export function pingFromFix(fix: FixLike, ref: ActiveTripRef): WirePing {
  const { coords } = fix;
  const inRange = (v: number | null | undefined, min: number, max: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
  return {
    vehicleId: ref.vehicleId,
    tripId: ref.tripId,
    latitude: coords.latitude,
    longitude: coords.longitude,
    altitude: inRange(coords.altitude, -1000, 20000),
    speed: inRange(coords.speed, 0, 200),
    heading: inRange(coords.heading, 0, 360),
    timestamp: new Date(fix.timestamp).toISOString(),
  };
}

// Split a drained buffer into server-acceptable batches (≤ BATCH_MAX each).
// In practice a D4 flush is a handful of fixes; the chunking exists so a
// pathological backlog can never 400 on the batch cap.
export function chunkPings(pings: readonly WirePing[], max: number = BATCH_MAX): WirePing[][] {
  const chunks: WirePing[][] = [];
  for (let i = 0; i < pings.length; i += max) {
    chunks.push(pings.slice(i, i + max));
  }
  return chunks;
}

// The flush decision: nothing buffered → never; otherwise on the count
// threshold or the interval cap, whichever trips first.
export function shouldFlush(bufferedCount: number, msSinceLastFlush: number): boolean {
  if (bufferedCount <= 0) {
    return false;
  }
  return bufferedCount >= FLUSH_MAX_PINGS || msSinceLastFlush >= FLUSH_MAX_INTERVAL_MS;
}
