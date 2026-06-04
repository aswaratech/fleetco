import { validateVertexInput } from "./geofences-schema";

// The pure draw ↔ `lon,lat;…` serializer for the Geofence map editor
// (ADR-0030 G4). This is the load-bearing coherence point between the
// Leaflet polygon-drawing surface and the unchanged storage contract: the
// map component (geofence-map-editor.tsx) reads the drawn ring's vertices,
// hands them here, and the result is the EXACT `lon,lat;lon,lat;…` vertex
// string the G3 coordinate-entry `boundary` field accepts and the API's
// shared PolygonParser (apps/api/src/common/wkt.ts) validates — so the map
// is a UI affordance over the same representation, not a new one. The map
// component itself touches `window` (Leaflet) and is not headlessly unit-
// testable; THIS module is, which is why the conversion lives here and is
// pinned by apps/web/test/geofence-latlng.test.ts.
//
// THE X,Y FOOT-GUN (the same one the API + G3 tests pin): Leaflet's LatLng
// is { lat, lng } — latitude first — while the `lon,lat` representation is
// LONGITUDE first. Serializing in the wrong order silently puts latitude
// where longitude belongs and ST_Contains misclassifies every fix. The
// order flip lives in exactly one place (ringToVertexInput) and is covered
// by an explicit order assertion in the test.

/**
 * The structural shape of a Leaflet `LatLng` (a `{ lat, lng }` object). We
 * accept the structural type rather than importing Leaflet so this module
 * stays pure and headlessly testable — Leaflet references `window` at module
 * load, which a Node/vitest run does not have. A real `L.LatLng` satisfies
 * this interface, so the map component passes its vertices straight through.
 */
export interface LatLngLike {
  lat: number;
  lng: number;
}

// Coordinate precision for the serialized ring. 6 decimal places is ~0.11 m
// at the equator — far finer than any depot / customer-site boundary needs,
// and it keeps the stored WKT clean by trimming the float noise a freehand
// map draw produces (e.g. 85.30000000000001 → "85.3"). The API stores
// whatever it receives, so this is purely a tidiness choice on the write
// path; it never changes which polygon is described to any meaningful
// resolution.
const COORD_DECIMALS = 6;

/**
 * Format a single coordinate to at most COORD_DECIMALS decimal places with
 * trailing zeros stripped, so 85.3 stays "85.3" (not "85.300000") and a
 * noisy 27.700000123 becomes "27.700000". `Number(...).toString()` never
 * emits exponential notation for values in the WGS84 range (|n| ≤ 180), so
 * the output is always a plain decimal the vertex parser accepts.
 */
function formatCoord(n: number): string {
  return Number(n.toFixed(COORD_DECIMALS)).toString();
}

/**
 * Serialize a drawn polygon ring (an array of Leaflet-style `{ lat, lng }`
 * vertices) to the `lon,lat;lon,lat;…` representation the `boundary` field
 * and the API's PolygonParser expect. LONGITUDE comes first in each pair
 * (the X,Y order WKT uses); the ring is left UNCLOSED (the API auto-closes
 * idempotently, exactly as the G3 coordinate-entry form sends it). An empty
 * ring serializes to "" (the form's "required" rule then rejects it).
 */
export function ringToVertexInput(ring: LatLngLike[]): string {
  return ring.map(({ lat, lng }) => `${formatCoord(lng)},${formatCoord(lat)}`).join(";");
}

/**
 * Parse a `lon,lat;lon,lat;…` vertex string into a `{ lat, lng }[]` for the
 * map editor to render as an editable polygon (the edit form pre-fills the
 * map from the stored boundary this way, after wktToVertexInput decodes the
 * stored `POLYGON((…))` WKT). Returns [] when the string is not a valid ring
 * (delegating the bounds/shape rules to validateVertexInput, the single
 * source of truth shared with the coordinate-entry field) — a defensive
 * fallback so a mid-typing or malformed value leaves the map untouched
 * rather than throwing.
 *
 * A stored ring is CLOSED (first vertex repeated last); the duplicate
 * closing vertex is dropped here so Geoman renders a clean N-gon without a
 * zero-length edge. Stripping only happens when it leaves ≥ 3 vertices, so a
 * valid ring never degrades below a triangle.
 */
export function vertexInputToLatLngs(raw: string): LatLngLike[] {
  if (validateVertexInput(raw) !== null) {
    return [];
  }
  const latlngs = raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((pair) => {
      const [lonStr, latStr] = pair.split(",");
      return { lat: Number(latStr), lng: Number(lonStr) };
    });

  // Drop a repeated closing vertex (A … A → A …) when doing so still leaves
  // a triangle or larger; the map draws an open ring and Geoman closes it
  // visually.
  if (latlngs.length >= 4) {
    const first = latlngs[0];
    const last = latlngs[latlngs.length - 1];
    if (first.lat === last.lat && first.lng === last.lng) {
      latlngs.pop();
    }
  }
  return latlngs;
}
