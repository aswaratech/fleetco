import { describe, expect, it } from "@jest/globals";

import {
  boundsForPins,
  formatDistanceKm,
  formatDuration,
  formatEtaLabel,
  routeLineString,
} from "./routing";

describe("formatDuration", () => {
  it("renders sub-hour durations as whole minutes", () => {
    expect(formatDuration(2700)).toBe("45 min"); // 45 min
    expect(formatDuration(90)).toBe("2 min"); // rounds to nearest minute
    expect(formatDuration(0)).toBe("0 min");
  });

  it("renders hour-plus durations as 'h min', dropping a zero minute", () => {
    expect(formatDuration(5400)).toBe("1 h 30 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(7200)).toBe("2 h");
  });
});

describe("formatDistanceKm", () => {
  it("rounds to a whole number at 10 km and above", () => {
    expect(formatDistanceKm(32000)).toBe("32 km");
    expect(formatDistanceKm(10000)).toBe("10 km");
  });

  it("keeps one decimal below 10 km (a short haul still reads)", () => {
    expect(formatDistanceKm(3200)).toBe("3.2 km");
    expect(formatDistanceKm(8400)).toBe("8.4 km");
    expect(formatDistanceKm(500)).toBe("0.5 km");
  });
});

describe("formatEtaLabel", () => {
  // The DESIGN §"Trip dispatch" preview label; "(estimated)" is the honesty
  // marker (the authoritative turn-by-turn is the Navigate deep-link).
  it("composes the '≈ 45 min · 32 km (estimated)' preview label", () => {
    expect(formatEtaLabel(32000, 2700)).toBe("≈ 45 min · 32 km (estimated)");
  });
});

describe("routeLineString", () => {
  // The load-bearing X=lon/Y=lat swap: the API returns [lat, lng] pairs; GeoJSON
  // (MapLibre) wants [lng, lat]. This is the one place the swap happens.
  it("converts [lat, lng] pairs to a GeoJSON LineString in [lng, lat] order", () => {
    const feature = routeLineString([
      [27.7031, 85.2925],
      [28.2096, 83.9856],
    ]);
    expect(feature).toEqual({
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [85.2925, 27.7031],
          [83.9856, 28.2096],
        ],
      },
    });
  });

  it("returns null for a degenerate (<2 points) geometry — no zero-length line", () => {
    expect(routeLineString([])).toBeNull();
    expect(routeLineString([[27.7031, 85.2925]])).toBeNull();
  });
});

describe("boundsForPins", () => {
  // MapLibre LngLatBounds is [west, south, east, north] = [minLng, minLat,
  // maxLng, maxLat], independent of which pin is pickup vs drop-off.
  it("returns [west, south, east, north] framing both pins", () => {
    const pickup = { latitude: 27.7031, longitude: 85.2925 };
    const dropoff = { latitude: 28.2096, longitude: 83.9856 };
    expect(boundsForPins(pickup, dropoff)).toEqual([83.9856, 27.7031, 85.2925, 28.2096]);
    // Order-independent: swapping the pins yields the same box.
    expect(boundsForPins(dropoff, pickup)).toEqual([83.9856, 27.7031, 85.2925, 28.2096]);
  });
});
