import { describe, expect, it } from "@jest/globals";

import {
  agePruneCutoffIso,
  OUTBOX_MAX_AGE_H,
  OUTBOX_MAX_ROWS,
  overCapDeleteCount,
  wirePingsFromRows,
  type OutboxRow,
} from "./outbox";

// D5's pure outbox policy (ADR-0035 c2). The load-bearing pins: the age-out
// cutoff compares chronologically as TEXT (the SQL prune relies on it), the
// row cap deletes exactly the overflow, and the row→wire mapping emits EXACTLY
// the server's `.strict()` keys — a leaked `id` would 400 the whole drain.

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1,
    vehicleId: "ckveh1234567890",
    tripId: "cktrip1234567890",
    latitude: 27.7172,
    longitude: 85.324,
    altitude: 1400,
    speed: 12.5,
    heading: 270,
    timestamp: "2026-07-11T06:30:00.000Z",
    ...overrides,
  };
}

describe("agePruneCutoffIso", () => {
  const now = Date.UTC(2026, 6, 11, 12, 0, 0);

  it("is exactly OUTBOX_MAX_AGE_H behind now, in toISOString format", () => {
    expect(agePruneCutoffIso(now)).toBe(
      new Date(now - OUTBOX_MAX_AGE_H * 3_600_000).toISOString(),
    );
    expect(agePruneCutoffIso(now)).toBe("2026-07-09T12:00:00.000Z");
  });

  it("orders lexicographically as time — the TEXT comparison the SQL prune uses", () => {
    const cutoff = agePruneCutoffIso(now);
    const justDead = new Date(now - OUTBOX_MAX_AGE_H * 3_600_000 - 1).toISOString();
    const justAlive = new Date(now - OUTBOX_MAX_AGE_H * 3_600_000 + 1).toISOString();
    expect(justDead < cutoff).toBe(true); // pruned: timestamp < cutoff
    expect(justAlive < cutoff).toBe(false); // kept
    expect(cutoff < cutoff).toBe(false); // exactly-at-cutoff is kept
  });
});

describe("overCapDeleteCount", () => {
  it("deletes nothing at or under the cap", () => {
    expect(overCapDeleteCount(0)).toBe(0);
    expect(overCapDeleteCount(OUTBOX_MAX_ROWS - 1)).toBe(0);
    expect(overCapDeleteCount(OUTBOX_MAX_ROWS)).toBe(0);
  });

  it("deletes exactly the overflow above the cap", () => {
    expect(overCapDeleteCount(OUTBOX_MAX_ROWS + 1)).toBe(1);
    expect(overCapDeleteCount(OUTBOX_MAX_ROWS + 250)).toBe(250);
  });
});

describe("wirePingsFromRows", () => {
  it("strips the row id and emits EXACTLY the server schema's keys", () => {
    const [ping] = wirePingsFromRows([row()]);
    expect(Object.keys(ping!).sort()).toEqual([
      "altitude",
      "heading",
      "latitude",
      "longitude",
      "speed",
      "timestamp",
      "tripId",
      "vehicleId",
    ]);
  });

  it("preserves order and passes null riders through", () => {
    const rows = [
      row({ id: 7, altitude: null, speed: null, heading: null }),
      row({ id: 8, timestamp: "2026-07-11T06:31:00.000Z" }),
    ];
    const pings = wirePingsFromRows(rows);
    expect(pings).toHaveLength(2);
    expect(pings[0]!.altitude).toBeNull();
    expect(pings[0]!.speed).toBeNull();
    expect(pings[0]!.heading).toBeNull();
    expect(pings[1]!.timestamp).toBe("2026-07-11T06:31:00.000Z");
  });
});
