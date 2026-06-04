import { describe, expect, test } from "vitest";

import { ringToVertexInput, vertexInputToLatLngs } from "../src/lib/geofence-latlng";
import { validateVertexInput } from "../src/lib/geofences-schema";

/**
 * Pins the pure draw ↔ `lon,lat;…` serializer (ADR-0030 G4) — the coherence
 * point between the Leaflet polygon-drawing surface and the unchanged
 * storage representation. The map component itself touches `window` and is
 * not headlessly unit-testable; this serializer is, and it is where the
 * X,Y (lon/lat) foot-gun the whole system guards against could silently
 * creep in, so it earns the coverage.
 *
 * Kathmandu coordinates (lon 85.x, lat 27.x) are used throughout — the two
 * are far enough apart that a swapped axis would be unmissable.
 */

// A drawn triangle as Leaflet would hand it to us: { lat, lng } objects,
// latitude first in the object, UNCLOSED (Leaflet's getLatLngs() omits the
// repeated closing vertex).
const DRAWN_RING = [
  { lat: 27.7, lng: 85.3 },
  { lat: 27.7, lng: 85.31 },
  { lat: 27.71, lng: 85.31 },
];

describe("ringToVertexInput", () => {
  test("serializes to lon,lat (X,Y) order — a swap would be visible here", () => {
    const out = ringToVertexInput(DRAWN_RING);
    // First drawn vertex is lat=27.7, lng=85.3 → must serialize lng-first as
    // "85.3,27.7", NEVER "27.7,85.3".
    expect(out.split(";")[0]).toBe("85.3,27.7");
    expect(out).toBe("85.3,27.7;85.31,27.7;85.31,27.71");
  });

  test("produces a string validateVertexInput accepts (representation coherence)", () => {
    expect(validateVertexInput(ringToVertexInput(DRAWN_RING))).toBeNull();
  });

  test("leaves the ring unclosed (the API auto-closes, like the G3 form)", () => {
    const out = ringToVertexInput(DRAWN_RING);
    expect(out.split(";")).toHaveLength(3);
  });

  test("rounds float noise from a freehand draw to 6 dp and strips trailing zeros", () => {
    const noisy = [
      { lat: 27.700000123, lng: 85.299999987 },
      { lat: 27.7, lng: 85.31 },
      { lat: 27.71, lng: 85.31 },
    ];
    // 85.299999987 → toFixed(6) "85.300000" → "85.3"; 27.700000123 → "27.7".
    expect(ringToVertexInput(noisy).split(";")[0]).toBe("85.3,27.7");
  });

  test("serializes an empty ring to the empty string", () => {
    expect(ringToVertexInput([])).toBe("");
  });
});

describe("vertexInputToLatLngs", () => {
  test("parses lon,lat;… into { lat, lng } with the axes un-swapped", () => {
    const out = vertexInputToLatLngs("85.3,27.7;85.31,27.7;85.31,27.71");
    expect(out).toHaveLength(3);
    // lon 85.3 must land in .lng, lat 27.7 in .lat.
    expect(out[0]).toEqual({ lat: 27.7, lng: 85.3 });
  });

  test("drops the repeated closing vertex of a stored (closed) ring", () => {
    // A stored boundaryWkt decodes to a closed ring; the map wants the open
    // form so Geoman renders a clean triangle.
    const out = vertexInputToLatLngs("85.3,27.7;85.31,27.7;85.31,27.71;85.3,27.7");
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ lat: 27.7, lng: 85.3 });
    expect(out[2]).toEqual({ lat: 27.71, lng: 85.31 });
  });

  test("returns [] for an invalid / non-ring string (defensive fallback)", () => {
    expect(vertexInputToLatLngs("not a ring")).toEqual([]);
    expect(vertexInputToLatLngs("85.3,27.7")).toEqual([]); // < 3 vertices
    expect(vertexInputToLatLngs("")).toEqual([]);
  });
});

describe("round-trip", () => {
  test("draw → string → latlngs → string is stable for an unclosed ring", () => {
    const asString = ringToVertexInput(DRAWN_RING);
    const backToLatLngs = vertexInputToLatLngs(asString);
    expect(ringToVertexInput(backToLatLngs)).toBe(asString);
  });

  test("string → latlngs → string preserves a known ring verbatim", () => {
    const ring = "85.3,27.7;85.31,27.7;85.31,27.71";
    expect(ringToVertexInput(vertexInputToLatLngs(ring))).toBe(ring);
  });
});
