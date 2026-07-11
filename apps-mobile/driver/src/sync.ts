// D5 SyncManager — the PURE half (ADR-0035 c2/c3). The drain decision, the
// backoff curve, and the outcome classifier: everything jest pins about WHEN
// the outbox drains and what a drain result means. The native glue (NetInfo
// listener, AppState trigger, interval tick, the actual POST loop) is
// src/sync-runtime.ts, which tests never import — the ADR-0033 c4 binary-free
// gate stays native-free. This module deliberately imports NOTHING (not even
// ./api's ApiError — that chain reaches native secure-store), so the error
// classifier reads `status` structurally.

// PROVISIONAL sync numbers (the owner-level-number pattern — ADR-0035
// ratifies the mechanics, the implementing slice pins the numbers):
//   - DRAIN_BATCH: rows per POST while draining. 300 pings ≈ 70 KB — under
//     the server's 1000-ping IngestBatchSchema cap with a 3× margin, AND
//     under body-parser's ~100 KB default, so the client stays safe even
//     against a server missing the D5 1mb-limit fix.
//   - SYNC_TICK_MS: the runtime's periodic drain check. Capture enqueues
//     roughly every 15 s; a 30 s tick bounds delivery latency at ~30 s while
//     online — comfortably inside the server's 120 s freshness-SLI window —
//     without a POST per fix.
//   - SYNC_BACKOFF_BASE_MS / SYNC_BACKOFF_CAP_MS: 5 s doubling to a 5 min
//     ceiling. Offline on a mountain route can last hours; retrying every
//     few seconds burns battery for nothing, and NetInfo's online transition
//     kicks an immediate drain anyway — backoff only governs the polling
//     floor while the network LOOKS up but the API is unreachable.
export const DRAIN_BATCH = 300;
export const SYNC_TICK_MS = 30_000;
export const SYNC_BACKOFF_BASE_MS = 5_000;
export const SYNC_BACKOFF_CAP_MS = 300_000;

// What the runtime knows when deciding whether to start a drain pass.
// `backoffDelayMs` is the delay the LAST failure chose (0 after success/none)
// — computed once per failure via backoffDelayMs() below, not re-rolled per
// check, so the decision is stable between ticks.
export interface SyncSnapshot {
  queueDepth: number;
  online: boolean;
  draining: boolean;
  msSinceLastAttempt: number;
  backoffDelayMs: number;
}

// Drain when there is something to send, the network looks up, no drain is
// already in flight, and the current backoff window has elapsed.
export function shouldDrain(snapshot: SyncSnapshot): boolean {
  return (
    snapshot.queueDepth > 0 &&
    snapshot.online &&
    !snapshot.draining &&
    snapshot.msSinceLastAttempt >= snapshot.backoffDelayMs
  );
}

// Exponential backoff with bounded jitter: 5s, 10s, 20s, ... capped at 5min,
// then up to +50% jitter on top. `jitterFraction` is caller-supplied
// randomness in [0,1) (the runtime passes Math.random()) so this stays
// deterministic under test. Jitter is ritual at a handful-of-phones fleet
// scale, but it costs nothing and keeps retry storms structurally impossible.
export function backoffDelayMs(consecutiveFailures: number, jitterFraction: number): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  const uncapped = SYNC_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1);
  const capped = Math.min(SYNC_BACKOFF_CAP_MS, uncapped);
  const jitter = Math.min(Math.max(jitterFraction, 0), 1);
  return Math.round(capped * (1 + 0.5 * jitter));
}

// Classify a failed drain POST (ADR-0035 c2's delivery discipline):
//   - "rejected": the server judged the payload and said no (4xx). Retrying
//     the same rows forever is wrong — the runtime DROPS the chunk with a
//     count-only warning. Two 4xx exceptions stay retryable:
//       401 — the SESSION is bad, not the fixes; apiFetch has already signed
//             the driver out, and the rows should survive until re-login;
//       429 — the server asked us to slow down, which is backoff's job.
//   - "retry": transport failure (no HTTP status at all) or a server-side
//     problem (5xx) — keep the rows, back off, try again.
// `status` is read structurally (see the header note on why not ApiError).
export type DrainFailure = "rejected" | "retry";

export function classifyDrainError(error: unknown): DrainFailure {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : null;
  if (status === null) {
    return "retry";
  }
  if (status === 401 || status === 429) {
    return "retry";
  }
  if (status >= 400 && status < 500) {
    return "rejected";
  }
  return "retry";
}
