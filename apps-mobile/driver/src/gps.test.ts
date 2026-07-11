import { describe, expect, it } from "@jest/globals";

import {
  BATCH_MAX,
  chunkPings,
  FLUSH_MAX_INTERVAL_MS,
  FLUSH_MAX_PINGS,
  pingFromFix,
  shouldFlush,
  type ActiveTripRef,
  type WirePing,
} from "./gps";

// D4's pure capture logic (ADR-0035 c1). The load-bearing pins: the wire ping
// matches the server's `.strict()` PingSchema EXACTLY (an extra key would 400
// the whole batch), out-of-range rider values become null (never clamped —
// a single clamped lie or -1 "unknown" would otherwise 400 the batch), and
// the flush decision holds the freshness envelope the server SLI measures.

const REF: ActiveTripRef = { tripId: "cktrip1234567890", vehicleId: "ckveh1234567890" };

function fix(overrides: Partial<{ coords: Partial<WirePing> & { latitude?: number; longitude?: number; altitude?: number | null; speed?: number | null; heading?: number | null }; timestamp: number }> = {}) {
  return {
    coords: {
      latitude: 27.7172,
      longitude: 85.324,
      altitude: 1400,
      speed: 12.5,
      heading: 270,
      ...(overrides.coords ?? {}),
    },
    timestamp: overrides.timestamp ?? Date.UTC(2026, 6, 11, 6, 30, 0),
  };
}

describe("pingFromFix", () => {
  it("maps a full fix onto the wire shape with an ISO timestamp", () => {
    const ping = pingFromFix(fix(), REF);
    expect(ping).toEqual({
      vehicleId: REF.vehicleId,
      tripId: REF.tripId,
      latitude: 27.7172,
      longitude: 85.324,
      altitude: 1400,
      speed: 12.5,
      heading: 270,
      timestamp: "2026-07-11T06:30:00.000Z",
    });
  });

  it("emits EXACTLY the server schema's keys — the .strict() contract", () => {
    const ping = pingFromFix(fix(), REF);
    expect(Object.keys(ping).sort()).toEqual([
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

  it("nulls Android's -1 'unknown' speed and heading instead of sending them", () => {
    const ping = pingFromFix(fix({ coords: { speed: -1, heading: -1 } }), REF);
    expect(ping.speed).toBeNull();
    expect(ping.heading).toBeNull();
  });

  it("nulls out-of-range riders rather than clamping (a clamp is a lie; the server would 400)", () => {
    const ping = pingFromFix(
      fix({ coords: { speed: 250, heading: 361, altitude: 25_000 } }),
      REF,
    );
    expect(ping.speed).toBeNull();
    expect(ping.heading).toBeNull();
    expect(ping.altitude).toBeNull();
  });

  it("keeps boundary riders the server accepts (heading 360, altitude -1000, speed 0)", () => {
    const ping = pingFromFix(fix({ coords: { speed: 0, heading: 360, altitude: -1000 } }), REF);
    expect(ping.speed).toBe(0);
    expect(ping.heading).toBe(360);
    expect(ping.altitude).toBe(-1000);
  });

  it("nulls missing riders", () => {
    const ping = pingFromFix(
      fix({ coords: { altitude: null, speed: null, heading: null } }),
      REF,
    );
    expect(ping.altitude).toBeNull();
    expect(ping.speed).toBeNull();
    expect(ping.heading).toBeNull();
  });
});

describe("chunkPings", () => {
  const ping = pingFromFix(fix(), REF);

  it("returns one chunk under the cap and splits above it", () => {
    expect(chunkPings([ping, ping])).toHaveLength(1);
    const many = Array.from({ length: BATCH_MAX + 1 }, () => ping);
    const chunks = chunkPings(many);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(BATCH_MAX);
    expect(chunks[1]).toHaveLength(1);
  });

  it("returns no chunks for an empty buffer (an empty batch would 400)", () => {
    expect(chunkPings([])).toHaveLength(0);
  });
});

describe("shouldFlush", () => {
  it("never flushes an empty buffer", () => {
    expect(shouldFlush(0, FLUSH_MAX_INTERVAL_MS * 2)).toBe(false);
  });

  it("flushes on the count threshold", () => {
    expect(shouldFlush(FLUSH_MAX_PINGS, 0)).toBe(true);
    expect(shouldFlush(FLUSH_MAX_PINGS - 1, 0)).toBe(false);
  });

  it("flushes on the interval cap even with one fix buffered", () => {
    expect(shouldFlush(1, FLUSH_MAX_INTERVAL_MS)).toBe(true);
    expect(shouldFlush(1, FLUSH_MAX_INTERVAL_MS - 1)).toBe(false);
  });
});
