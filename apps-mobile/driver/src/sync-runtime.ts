// D5 SyncManager — the NATIVE glue (ADR-0035 c2/c3). The single sender: every
// buffered fix leaves the device through the drain loop here, via the existing
// postGpsPings. Triggers are event-driven plus a slow tick — NetInfo's
// offline→online transition, AppState returning to the foreground, the
// SYNC_TICK_MS interval, and the trip-stop boundary's explicit drainOutboxNow.
// All DECISIONS (when to drain, how long to back off, what a failure means)
// live in src/sync.ts, the pure half jest pins; this file only wires them to
// the world. Warnings are count-only — never a coordinate (ADR-0027 c5).
//
// Started by App.tsx when the signed-in shell mounts (startSync is idempotent).
// Deliberately NOT started from the headless task runtime: the auth client
// hydrates its session asynchronously, and a drain racing that hydration would
// POST cookieless → 401 → apiFetch signs the driver out. Headless capture
// only enqueues; the next real app open delivers. The cookie interlock below
// is the second layer of the same protection.

import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";

import { postGpsPings } from "./api";
import { authClient } from "./auth";
import { wirePingsFromRows } from "./outbox";
import { deletePings, outboxDepth, peekOldestPings } from "./outbox-sqlite";
import {
  backoffDelayMs,
  classifyDrainError,
  DRAIN_BATCH,
  shouldDrain,
  SYNC_TICK_MS,
} from "./sync";

let started = false;
// NetInfo reports isConnected: boolean | null (null = not yet determined).
// Treat only an explicit `false` as offline — optimism costs one failed POST
// and a backoff; pessimism would strand the queue until the first event fires.
let online = true;
let lastAttemptAt = 0;
let consecutiveFailures = 0;
let currentBackoffMs = 0;
let drainPromise: Promise<void> | null = null;

// One drain pass: send oldest-first chunks until the outbox is empty or a
// retryable failure stops the pass. Outcomes per src/sync.ts classify:
// delivered → delete rows; rejected (server-judged 4xx) → DROP the chunk with
// a count-only warning and keep going (the transport is healthy — and each
// drop shrinks the queue, so this terminates); retry (network/5xx/401/429) →
// keep the rows, arm the backoff, end the pass.
async function drain(): Promise<void> {
  try {
    for (;;) {
      // The interlock: no session credential, no attempt. Prevents the
      // logged-out (and headless half-hydrated) drain from 401-ing, which
      // would make apiFetch sign the driver out — rows just wait for login.
      if (!authClient.getCookie()) {
        consecutiveFailures += 1;
        currentBackoffMs = backoffDelayMs(consecutiveFailures, Math.random());
        return;
      }
      const rows = await peekOldestPings(DRAIN_BATCH);
      if (rows.length === 0) {
        return;
      }
      try {
        await postGpsPings(wirePingsFromRows(rows));
        await deletePings(rows.map((row) => row.id));
        consecutiveFailures = 0;
        currentBackoffMs = 0;
      } catch (error) {
        if (classifyDrainError(error) === "rejected") {
          // The server judged these rows and said no — e.g. a batch straddling
          // a trip ended from the office while capture kept running (the whole
          // batch 403s on one out-of-window ping; the reconcile stops such
          // orphaned capture on the next app open). Retrying forever is wrong.
          await deletePings(rows.map((row) => row.id));
          console.warn(`sync: server rejected ${rows.length} buffered fix(es); dropped`);
          consecutiveFailures = 0;
          currentBackoffMs = 0;
          continue;
        }
        consecutiveFailures += 1;
        currentBackoffMs = backoffDelayMs(consecutiveFailures, Math.random());
        return;
      }
    }
  } finally {
    lastAttemptAt = Date.now();
  }
}

// Coalesce concurrent triggers onto one in-flight pass. The loop re-peeks
// until empty, so rows enqueued while a pass runs are usually swept by it.
function runDrain(): Promise<void> {
  if (!drainPromise) {
    drainPromise = drain()
      .catch(() => {
        // drain() only throws on an outbox failure; the next trigger retries.
      })
      .finally(() => {
        drainPromise = null;
      });
  }
  return drainPromise;
}

// Evaluate the pure decision against live state; drain if it says go.
async function kickSync(): Promise<void> {
  try {
    const queueDepth = await outboxDepth();
    const snapshot = {
      queueDepth,
      online,
      draining: drainPromise !== null,
      msSinceLastAttempt: Date.now() - lastAttemptAt,
      backoffDelayMs: currentBackoffMs,
    };
    if (shouldDrain(snapshot)) {
      await runDrain();
    }
  } catch {
    // a failed check is just skipped; the next trigger re-evaluates
  }
}

// The trip-stop boundary (called by stopTripGps BEFORE the stop PATCH): push
// the tail out NOW, bypassing any armed backoff — a user action is better
// evidence than a timer that the network may be back. If the drain fails
// (genuinely offline), the rows stay buffered and the server's COMPLETED-trip
// late-delivery window (ADR-0035 c5) accepts them on reconnect.
export async function drainOutboxNow(): Promise<void> {
  if ((await outboxDepth()) === 0) {
    return;
  }
  await runDrain();
}

// Wire the triggers once, from the signed-in shell's mount. Idempotent; never
// throws (a broken trigger wiring must not take the app down with it).
export function startSync(): void {
  if (started) {
    return;
  }
  started = true;
  try {
    NetInfo.addEventListener((state) => {
      const wasOnline = online;
      online = state.isConnected !== false;
      if (!wasOnline && online) {
        void kickSync();
      }
    });
    AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void kickSync();
      }
    });
    setInterval(() => {
      void kickSync();
    }, SYNC_TICK_MS);
    // Sweep anything buffered before this session (an offline stop last
    // night, a headless capture) as soon as the shell is up.
    void kickSync();
  } catch {
    console.warn("sync: trigger wiring failed; buffered fixes will wait for a manual drain");
  }
}
