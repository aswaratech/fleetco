// GPS capture — the NATIVE shell (ADR-0035 c1/c2/c8, D5 shape). Capture is
// bound to the active trip and picks its mechanism by permission:
//
//   - WITH "Allow all the time" (ACCESS_BACKGROUND_LOCATION): an
//     expo-task-manager task fed by startLocationUpdatesAsync running a
//     FOREGROUND SERVICE with a persistent notification — capture survives
//     backgrounding, screen-off, and (killServiceOnDestroy: false) even the
//     app's task being swiped away. This is exactly the mechanism D4 had to
//     back away from: on Android 14+/API 35 the service hard-crashed when a
//     fix arrived backgrounded WITHOUT background permission (the LocationTask-
//     Consumer FATAL recorded in ADR-0035's 2026-07-10 annotation). Background
//     permission is what makes it stable, so this path is gated on it.
//   - WITHOUT it: the D4 `watchPositionAsync` in-JS watch — foreground-only,
//     paused on background (an explicit, honest gap; the AppState handler
//     below). Declining the onboarding upsell keeps a driver here forever,
//     degraded but functional (ADR-0035 c1 best-effort posture).
//
// Both paths write every fix STRAIGHT to the encrypted outbox
// (src/outbox-sqlite.ts) — no in-JS buffer, no direct POST. Durability is the
// outbox's job and ALL delivery is the SyncManager's (src/sync-runtime.ts);
// this file never talks to the API.
//
// Headless truth: after a force-stop the surviving service re-launches the JS
// runtime WITHOUT React — module state resets, so the trip binding lives in
// expo-secure-store (ids only, no coordinates) and the task handler re-reads
// it. Headless fixes are enqueued but NOT drained: the auth client hydrates
// asynchronously and a drain racing it could 401 → sign the driver out. The
// next real app open (or the FGS running with the app alive) delivers.
// Failures never throw out of the task handler and never log a coordinate
// (ADR-0027 c5, mobile mirror).

import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";

import {
  CAPTURE_DISTANCE_M,
  CAPTURE_INTERVAL_MS,
  pingFromFix,
  type ActiveTripRef,
} from "./gps";
import { enqueuePings } from "./outbox-sqlite";
import { drainOutboxNow } from "./sync-runtime";

export const GPS_TASK_NAME = "fleetco-gps-capture";
const ACTIVE_TRIP_KEY = "fleetco.gps.activeTrip";

let activeRef: ActiveTripRef | null = null;
let watch: Location.LocationSubscription | null = null;
let appStateWired = false;

// The trip binding, surviving a headless relaunch: memory first, secure-store
// as the durable copy (written on start, cleared on stop).
async function resolveActiveRef(): Promise<ActiveTripRef | null> {
  if (activeRef) {
    return activeRef;
  }
  try {
    const raw = await SecureStore.getItemAsync(ACTIVE_TRIP_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { tripId?: unknown }).tripId === "string" &&
      typeof (parsed as { vehicleId?: unknown }).vehicleId === "string"
    ) {
      activeRef = parsed as ActiveTripRef;
      return activeRef;
    }
    return null;
  } catch {
    return null;
  }
}

// Buffer fixes durably against the bound trip. An outbox failure costs those
// fixes (count-only warning — c1's gap tolerance), never the capture loop.
async function enqueueFixes(fixes: readonly Location.LocationObject[]): Promise<void> {
  const ref = await resolveActiveRef();
  if (!ref || fixes.length === 0) {
    return;
  }
  try {
    await enqueuePings(fixes.map((fix) => pingFromFix(fix, ref)));
  } catch {
    console.warn(`gps: lost ${fixes.length} fix(es) — the outbox write failed`);
  }
}

// The background task. Defined at module scope so it exists in every JS init,
// INCLUDING the headless relaunch after a force-stop (index.ts imports this
// module explicitly for that reason). The executor AWAITS the outbox write —
// a headless runtime may be torn down as soon as the returned promise
// settles, and a fire-and-forget insert could be killed mid-write. It never
// rejects (enqueueFixes catches internally) — a task-handler crash would take
// the foreground service down with it.
TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
  GPS_TASK_NAME,
  async ({ data, error }) => {
    if (error || !data || !Array.isArray(data.locations)) {
      return;
    }
    await enqueueFixes(data.locations);
  },
);

// ——— the watchPositionAsync fallback (no background permission) ———

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
    (fix) => void enqueueFixes([fix]),
  );
}

function endWatch(): void {
  if (watch) {
    watch.remove();
    watch = null;
  }
}

// The fallback path is foreground-only (ADR-0035 c8's D4 window): pause the
// watch on background, resume on foreground while a trip is bound. The FGS
// path needs none of this — running backgrounded is its whole point. Fixes
// are already in the outbox, so pausing loses nothing buffered.
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
        } else if (state === "active" && activeRef && !watch) {
          const fgsRunning = await isFgsCapturing();
          if (!fgsRunning) {
            await beginWatch();
          }
        }
      } catch {
        // pause/resume is best-effort; the reconcile on trips load backstops it.
      }
    })();
  });
}

// ——— the foreground-service path (background permission granted) ———

async function isFgsCapturing(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(GPS_TASK_NAME);
  } catch {
    return false; // no task-manager runtime (Expo Go) — the watch path owns capture
  }
}

async function beginFgs(): Promise<void> {
  await Location.startLocationUpdatesAsync(GPS_TASK_NAME, {
    accuracy: Location.Accuracy.High,
    timeInterval: CAPTURE_INTERVAL_MS,
    distanceInterval: CAPTURE_DISTANCE_M,
    foregroundService: {
      notificationTitle: "FleetCo trip running",
      notificationBody: "Recording the route while you drive.",
      // Survive the app's task being swiped away: the service (and capture)
      // keeps running; the headless task handler buffers into the outbox.
      killServiceOnDestroy: false,
    },
  });
}

async function endFgs(): Promise<void> {
  if (await isFgsCapturing()) {
    await Location.stopLocationUpdatesAsync(GPS_TASK_NAME);
  }
}

// ——— the public surface (App.tsx + reconcile) ———

export type StartGpsResult =
  | "started-background"
  | "started-foreground"
  | "denied"
  | "unavailable";

// Start capture for a trip that is ALREADY IN_PROGRESS server-side (the caller
// patches the trip first). Foreground permission is requested here (the D4
// behavior); BACKGROUND permission is only ever requested by the onboarding
// card (src/gps-onboarding.ts) — this function just picks the mechanism the
// current grants allow. Denial is not an error: the trip proceeds and the
// caller shows an honest note. "unavailable" covers a runtime without the
// native location module (Expo Go).
export async function startTripGps(ref: ActiveTripRef): Promise<StartGpsResult> {
  try {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) {
      return "denied";
    }
    activeRef = ref;
    await SecureStore.setItemAsync(ACTIVE_TRIP_KEY, JSON.stringify(ref));
    const background = await Location.getBackgroundPermissionsAsync();
    if (background.granted) {
      try {
        await beginFgs();
        return "started-background";
      } catch {
        // The service refused to start (OEM quirk, Expo Go) — fall through to
        // the watch rather than losing capture entirely.
      }
    }
    await beginWatch();
    wireAppStatePauseResume();
    return "started-foreground";
  } catch {
    activeRef = null;
    endWatch();
    try {
      await SecureStore.deleteItemAsync(ACTIVE_TRIP_KEY);
    } catch {
      // best-effort cleanup; a stale binding is re-checked against the trip
      // list by the reconcile anyway.
    }
    return "unavailable";
  }
}

// Stop capture, then push the buffered tail out. Called BEFORE the trip-stop
// PATCH: an online drain here still targets an IN_PROGRESS trip, and an
// offline one is covered later by the server's COMPLETED-trip late-delivery
// window (ADR-0035 c5 — the D5 predicate evolution). Never throws — a capture
// problem must not block ending the trip.
export async function stopTripGps(): Promise<void> {
  try {
    await endFgs();
  } catch {
    // stopping a service that never ran (or has no runtime) is fine
  }
  endWatch();
  activeRef = null;
  try {
    await SecureStore.deleteItemAsync(ACTIVE_TRIP_KEY);
  } catch {
    // stale binding is harmless — see startTripGps
  }
  try {
    await drainOutboxNow();
  } catch {
    // delivery failures are the SyncManager's to retry; stopping always succeeds
  }
}

// Self-heal on trips load (an app relaunch mid-trip, or a trip ended
// elsewhere while capture kept running):
//   - an IN_PROGRESS trip + foreground permission + no capture running →
//     resume silently (get*, never request* — no prompt from a list load);
//   - no IN_PROGRESS trip + any capture running → stop, clear, drain.
// Structural trip type so this stays decoupled from src/trips.ts.
export async function reconcileTripGps(
  trips: readonly { id: string; status: string; vehicle: { id: string } }[],
): Promise<void> {
  try {
    const inProgress = trips.find((trip) => trip.status === "IN_PROGRESS");
    const capturing = watch !== null || (await isFgsCapturing());
    if (inProgress && !capturing) {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.granted) {
        await startTripGps({ tripId: inProgress.id, vehicleId: inProgress.vehicle.id });
      }
    } else if (!inProgress && capturing) {
      await stopTripGps();
    }
  } catch {
    // reconciliation is best-effort by definition
  }
}
