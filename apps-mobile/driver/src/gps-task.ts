// D4 foreground GPS capture — the NATIVE shell (ADR-0035 c1). An Android
// foreground service bound to the active trip: started on trip-start, stopped
// on trip-stop, with a persistent notification visible for exactly as long as
// capture runs, so tracking a company vehicle's work use is explicit and never
// covert (ADR-0027 c2). Capture is BEST-EFFORT AND GAP-TOLERANT BY DESIGN: a
// failed flush drops the buffered fixes with a count-only warning — never a
// coordinate (the mobile mirror of ADR-0027 c5) — and durability (the
// SQLCipher outbox + SyncManager) is D5's slice, not this one.
//
// Tests never import this file (native modules); the logic they pin lives in
// src/gps.ts. This module is registered from index.ts so the task exists
// before the app registers.

import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";

import { postGpsPings } from "./api";
import {
  CAPTURE_DISTANCE_M,
  CAPTURE_INTERVAL_MS,
  chunkPings,
  pingFromFix,
  shouldFlush,
  type ActiveTripRef,
  type WirePing,
} from "./gps";

export const GPS_TASK = "fleetco-trip-gps";

// The active-trip binding survives an app relaunch mid-trip via secure-store
// (module state does not); the task lazy-loads it so fixes delivered after a
// relaunch still map to the right trip.
const ACTIVE_TRIP_KEY = "fleetco.activeTrip";

let activeRef: ActiveTripRef | null = null;
let buffer: WirePing[] = [];
let lastFlushAt = 0;
let flushing = false;

async function loadStoredRef(): Promise<ActiveTripRef | null> {
  try {
    const raw = await SecureStore.getItemAsync(ACTIVE_TRIP_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as ActiveTripRef).tripId === "string" &&
      typeof (parsed as ActiveTripRef).vehicleId === "string"
    ) {
      return parsed as ActiveTripRef;
    }
  } catch {
    // fall through — a corrupt stored ref reads as "no active trip".
  }
  return null;
}

// Drain the buffer to the API. Failure = drop, count-only warning (gap-tolerant
// per ADR-0035 c1; the D5 outbox is where durability lands). Coalesces
// concurrent calls.
async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) {
    return;
  }
  flushing = true;
  const toSend = buffer;
  buffer = [];
  lastFlushAt = Date.now();
  try {
    for (const batch of chunkPings(toSend)) {
      await postGpsPings(batch);
    }
  } catch {
    console.warn(`gps: dropped ${toSend.length} buffered fix(es) after a failed flush`);
  } finally {
    flushing = false;
  }
}

// The location task. Runs in the app's JS runtime while the foreground service
// is live; collects fixes against the active trip and flushes on the pure
// decision rule. A fix arriving with no resolvable active trip is dropped —
// never guessed at.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
  GPS_TASK,
  async ({ data, error }) => {
    if (error) {
      console.warn(`gps: location task error (${error.code})`);
      return;
    }
    if (!data || !Array.isArray(data.locations) || data.locations.length === 0) {
      return;
    }
    if (!activeRef) {
      activeRef = await loadStoredRef();
      if (!activeRef) {
        return;
      }
    }
    for (const fix of data.locations) {
      buffer.push(pingFromFix(fix, activeRef));
    }
    if (shouldFlush(buffer.length, Date.now() - lastFlushAt)) {
      await flush();
    }
  },
);

export type StartGpsResult = "started" | "denied" | "unavailable";

// Start capture for a trip that is ALREADY IN_PROGRESS server-side (the
// caller patches the trip first — the server's own-trip predicate rejects
// pings for a non-IN_PROGRESS trip). Permission denial is NOT an error: the
// trip proceeds and the caller shows an honest note (best-effort posture).
// "unavailable" covers a runtime without the native module wired for a
// foreground service (Expo Go) — same honest degradation.
export async function startTripGps(ref: ActiveTripRef): Promise<StartGpsResult> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      return "denied";
    }
    activeRef = ref;
    buffer = [];
    lastFlushAt = Date.now();
    await SecureStore.setItemAsync(ACTIVE_TRIP_KEY, JSON.stringify(ref));
    await Location.startLocationUpdatesAsync(GPS_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: CAPTURE_INTERVAL_MS,
      distanceInterval: CAPTURE_DISTANCE_M,
      foregroundService: {
        notificationTitle: "FleetCo — trip in progress",
        notificationBody: "Recording this vehicle's route while the trip runs.",
        // D4 is foreground-bound: if Android kills the app, the service dies
        // with it (an honest gap). Keeping the service alive past the app is
        // D5's background slice, revisited there.
        killServiceOnDestroy: true,
      },
    });
    return "started";
  } catch {
    activeRef = null;
    try {
      await SecureStore.deleteItemAsync(ACTIVE_TRIP_KEY);
    } catch {
      // best-effort cleanup
    }
    return "unavailable";
  }
}

// Stop capture and drain the tail. Called BEFORE the trip-stop PATCH so the
// final flush still targets an IN_PROGRESS trip (the server predicate would
// 403 it afterwards). Never throws — a capture problem must not block ending
// the trip.
export async function stopTripGps(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(GPS_TASK)) {
      await Location.stopLocationUpdatesAsync(GPS_TASK);
    }
  } catch {
    // proceed to drain regardless
  }
  try {
    await flush();
  } catch {
    // flush never throws, but stay airtight — stopping must always succeed.
  }
  activeRef = null;
  try {
    await SecureStore.deleteItemAsync(ACTIVE_TRIP_KEY);
  } catch {
    // best-effort cleanup
  }
}

// Self-heal on trips load (app relaunch mid-trip, or a trip ended elsewhere):
//   - an IN_PROGRESS trip + permission already granted + capture not running →
//     restart capture silently (no prompt: uses getForegroundPermissionsAsync);
//   - no IN_PROGRESS trip + capture running → stop and drain.
// Structural trip type so this stays decoupled from src/trips.ts.
export async function reconcileTripGps(
  trips: readonly { id: string; status: string; vehicle: { id: string } }[],
): Promise<void> {
  try {
    const inProgress = trips.find((trip) => trip.status === "IN_PROGRESS");
    const running = await Location.hasStartedLocationUpdatesAsync(GPS_TASK);
    if (inProgress && !running) {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.granted) {
        await startTripGps({ tripId: inProgress.id, vehicleId: inProgress.vehicle.id });
      }
    } else if (!inProgress && running) {
      await stopTripGps();
    }
  } catch {
    // reconciliation is best-effort by definition
  }
}
