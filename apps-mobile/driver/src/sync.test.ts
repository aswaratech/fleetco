import { describe, expect, it } from "@jest/globals";

import { BATCH_MAX } from "./gps";
import {
  backoffDelayMs,
  classifyDrainError,
  DRAIN_BATCH,
  shouldDrain,
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_CAP_MS,
  type SyncSnapshot,
} from "./sync";

// D5's pure sync logic (ADR-0035 c2/c3). The load-bearing pins: the drain
// decision gates on every input, the backoff curve is bounded on both ends,
// the classifier never drops rows on a transport failure (only on a real
// server rejection), and the drain chunk stays inside the server's batch cap.

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    queueDepth: 10,
    online: true,
    draining: false,
    msSinceLastAttempt: 60_000,
    backoffDelayMs: 0,
    ...overrides,
  };
}

describe("shouldDrain", () => {
  it("drains the happy path", () => {
    expect(shouldDrain(snapshot())).toBe(true);
  });

  it("never drains an empty queue", () => {
    expect(shouldDrain(snapshot({ queueDepth: 0 }))).toBe(false);
  });

  it("never drains offline", () => {
    expect(shouldDrain(snapshot({ online: false }))).toBe(false);
  });

  it("never starts a second drain while one is in flight", () => {
    expect(shouldDrain(snapshot({ draining: true }))).toBe(false);
  });

  it("waits out the backoff window, then drains at exactly its edge", () => {
    expect(
      shouldDrain(snapshot({ backoffDelayMs: 10_000, msSinceLastAttempt: 9_999 })),
    ).toBe(false);
    expect(
      shouldDrain(snapshot({ backoffDelayMs: 10_000, msSinceLastAttempt: 10_000 })),
    ).toBe(true);
  });
});

describe("backoffDelayMs", () => {
  it("is zero with no failures", () => {
    expect(backoffDelayMs(0, 0.5)).toBe(0);
    expect(backoffDelayMs(-1, 0.5)).toBe(0);
  });

  it("doubles from the base without jitter", () => {
    expect(backoffDelayMs(1, 0)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(backoffDelayMs(2, 0)).toBe(SYNC_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3, 0)).toBe(SYNC_BACKOFF_BASE_MS * 4);
  });

  it("caps at the ceiling before jitter (5s base -> 5min cap)", () => {
    expect(backoffDelayMs(7, 0)).toBe(SYNC_BACKOFF_CAP_MS);
    expect(backoffDelayMs(50, 0)).toBe(SYNC_BACKOFF_CAP_MS);
  });

  it("bounds jitter at +50% and clamps an out-of-range fraction", () => {
    expect(backoffDelayMs(1, 0.999999)).toBeLessThanOrEqual(
      Math.round(SYNC_BACKOFF_BASE_MS * 1.5),
    );
    expect(backoffDelayMs(1, 1)).toBe(Math.round(SYNC_BACKOFF_BASE_MS * 1.5));
    expect(backoffDelayMs(1, 2)).toBe(Math.round(SYNC_BACKOFF_BASE_MS * 1.5));
    expect(backoffDelayMs(1, -1)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(backoffDelayMs(50, 1)).toBe(Math.round(SYNC_BACKOFF_CAP_MS * 1.5));
  });
});

describe("classifyDrainError", () => {
  it("retries a transport failure (no HTTP status)", () => {
    expect(classifyDrainError(new TypeError("Network request failed"))).toBe("retry");
    expect(classifyDrainError(undefined)).toBe("retry");
  });

  it("rejects a server-judged 4xx (the rows are bad; retrying forever is wrong)", () => {
    expect(classifyDrainError({ status: 400 })).toBe("rejected");
    expect(classifyDrainError({ status: 403 })).toBe("rejected");
    expect(classifyDrainError({ status: 413 })).toBe("rejected");
  });

  it("retries 401 (the SESSION is bad, not the fixes) and 429 (server said slow down)", () => {
    expect(classifyDrainError({ status: 401 })).toBe("retry");
    expect(classifyDrainError({ status: 429 })).toBe("retry");
  });

  it("retries 5xx", () => {
    expect(classifyDrainError({ status: 500 })).toBe("retry");
    expect(classifyDrainError({ status: 503 })).toBe("retry");
  });

  it("ignores a non-numeric status shape", () => {
    expect(classifyDrainError({ status: "418" })).toBe("retry");
  });
});

describe("cross-constant pins", () => {
  it("keeps the drain chunk inside the server's batch cap", () => {
    expect(DRAIN_BATCH).toBeLessThanOrEqual(BATCH_MAX);
  });
});
