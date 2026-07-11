// D4 foreground GPS capture — the NATIVE shell (ADR-0035 c1/c8). A
// FOREGROUND-ONLY location watch bound to the active trip: it captures exactly
// while a trip is IN_PROGRESS and the app is foregrounded (ADR-0035 c8's D4
// window), which is honest by construction — the app is visibly open on the
// driver's screen the whole time.
//
// D4 uses `Location.watchPositionAsync` (an in-JS subscription), NOT a
// foreground SERVICE + expo-task-manager. The reason is discovered, not
// theoretical: on Android 14+/API 35 a `location`-type foreground service
// cannot be (re)started from the background, and expo-location's task
// consumer hard-CRASHES the process when a fix is delivered while the app is
// backgrounded (observed live on the SDK-56 emulator: LocationTaskConsumer
// "Foreground location task cannot be started while the app is in the
// background!" → FATAL). A JS-side stop races that native broadcast receiver
// and cannot win. `watchPositionAsync` registers no background receiver, so
// it structurally cannot hit that crash. The foreground SERVICE + persistent
// notification + ACCESS_BACKGROUND_LOCATION + the encrypted outbox is exactly
// D5's slice (ADR-0035 c1/c2) — where background permission makes the service
// stable. This D4/D5 split is recorded in ADR-0035's 2026-07-10 annotation.
//
// Capture is BEST-EFFORT AND GAP-TOLERANT BY DESIGN (ADR-0035 c1): a failed
// flush drops the buffered fixes with a count-only warning — never a
// coordinate (the mobile mirror of ADR-0027 c5) — and durability is D5's
// outbox, not this slice. When the app backgrounds, capture stops and the
// buffer drains (an explicit gap, not a crash); it resumes on foreground if
// the trip is still active. Tests never import this file (native modules); the
// pure logic they pin lives in src/gps.ts.

import * as Location from "expo-location";
import { AppState } from "react-native";

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

let activeRef: ActiveTripRef | null = null;
let watch: Location.LocationSubscription | null = null;
let buffer: WirePing[] = [];
let lastFlushAt = 0;
let flushing = false;
let appStateWired = false;

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

// Handle one fix from the watch: map it against the active trip, buffer it, and
// flush on the pure decision rule. A fix with no active trip is dropped.
function onFix(fix: Location.LocationObject): void {
  if (!activeRef) {
    return;
  }
  buffer.push(pingFromFix(fix, activeRef));
  if (shouldFlush(buffer.length, Date.now() - lastFlushAt)) {
    void flush();
  }
}

// Begin the in-JS location watch with the D4 capture options. Shared by
// startTripGps and the foreground-resume path so both use identical options.
async function beginWatch(): Promise<void> {
  if (watch) {
    return;
  }
  watch = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: CAPTURE_INTERVAL_MS,
      distanceInterval: CAPTURE_DISTANCE_M,
    },
    onFix,
  );
}

// Stop the watch (idempotent).
function endWatch(): void {
  if (watch) {
    watch.remove();
    watch = null;
  }
}

// D4 is foreground-only (ADR-0035 c8). On background, stop the watch and drain
// the buffer (an explicit gap — c1's gap-tolerance); on foreground, resume if a
// trip is still bound. Wired once, on first capture start.
function wireAppStatePauseResume(): void {
  if (appStateWired) {
    return;
  }
  appStateWired = true;
  AppState.addEventListener("change", (state) => {
    void (async () => {
      try {
        if (state === "background" || state === "inactive") {
          endWatch();
          await flush();
        } else if (state === "active" && activeRef && !watch) {
          await beginWatch();
        }
      } catch {
        // pause/resume is best-effort; the reconcile on trips load backstops it.
      }
    })();
  });
}

export type StartGpsResult = "started" | "denied" | "unavailable";

// Start capture for a trip that is ALREADY IN_PROGRESS server-side (the caller
// patches the trip first — the server's own-trip predicate rejects pings for a
// non-IN_PROGRESS trip). Permission denial is NOT an error: the trip proceeds
// and the caller shows an honest note (best-effort posture, ADR-0035 c1).
// "unavailable" covers a runtime without the native location module (Expo Go).
export async function startTripGps(ref: ActiveTripRef): Promise<StartGpsResult> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      return "denied";
    }
    activeRef = ref;
    buffer = [];
    lastFlushAt = Date.now();
    await beginWatch();
    wireAppStatePauseResume();
    return "started";
  } catch {
    activeRef = null;
    endWatch();
    return "unavailable";
  }
}

// Stop capture and drain the tail. Called BEFORE the trip-stop PATCH so the
// final flush still targets an IN_PROGRESS trip (the server predicate would
// 403 it afterwards). Never throws — a capture problem must not block ending
// the trip.
export async function stopTripGps(): Promise<void> {
  endWatch();
  activeRef = null;
  try {
    await flush();
  } catch {
    // flush never throws, but stay airtight — stopping must always succeed.
  }
}

// Self-heal on trips load (an app relaunch mid-trip, or a trip ended elsewhere):
//   - an IN_PROGRESS trip + permission already granted + no active watch →
//     resume capture silently (getForegroundPermissionsAsync — no prompt);
//   - no IN_PROGRESS trip + an active watch → stop and drain.
// Structural trip type so this stays decoupled from src/trips.ts.
export async function reconcileTripGps(
  trips: readonly { id: string; status: string; vehicle: { id: string } }[],
): Promise<void> {
  try {
    const inProgress = trips.find((trip) => trip.status === "IN_PROGRESS");
    if (inProgress && !watch) {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.granted) {
        await startTripGps({ tripId: inProgress.id, vehicleId: inProgress.vehicle.id });
      }
    } else if (!inProgress && watch) {
      await stopTripGps();
    }
  } catch {
    // reconciliation is best-effort by definition
  }
}
