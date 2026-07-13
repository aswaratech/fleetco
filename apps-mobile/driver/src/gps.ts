// GPS capture — the PURE half (ADR-0035 c1, D4; reshaped by D5). Wire-ping
// construction from a location fix and the capture-cadence constants. The
// native shell (task definition, start/stop, outbox writes) is
// src/gps-task.ts, which tests never import — the ADR-0033 c4 binary-free
// gate stays native-free. D4's in-JS buffer + flush-decision helpers lived
// here too; D5 removed them — every captured fix now goes straight to the
// encrypted outbox and the SyncManager (src/sync.ts) owns all delivery.

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

// PROVISIONAL capture numbers. ADR-0035 ratifies the MECHANICS and
// deliberately pins no numbers — these are the implementing slice's
// documented provisionals (the owner-level-number pattern: the GPS-retention
// window, the due-soon windows), tuned with pilot data later: a fix at most
// every CAPTURE_INTERVAL_MS, or every CAPTURE_DISTANCE_M of travel, whichever
// the OS honors first. Delivery cadence is the SyncManager's (src/sync.ts:
// SYNC_TICK_MS bounds latency inside the server's 120s freshness-SLI window).
export const CAPTURE_INTERVAL_MS = 15_000;
export const CAPTURE_DISTANCE_M = 25;

// The server's IngestBatchSchema cap (batch max 1000) — mirrored, not
// imported. The drain chunk (src/sync.ts DRAIN_BATCH) must stay under it;
// a cross-constant test pins that.
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

