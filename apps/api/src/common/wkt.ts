import { z } from "zod";

// Shared WKT polygon builder — the ONE place FleetCo turns a
// `lon,lat;lon,lat;…` vertex representation into a closed `POLYGON((…))`
// WKT ring. Extracted from telematics.schemas.ts (where the GPS T5 read
// slice first authored it) so that BOTH the telematics geofence-status
// query (a caller-parameterized, throwaway fence) AND the stored
// Geofence aggregate (ADR-0030) build their WKT from the SAME code.
//
// WHY THIS IS A SHARED MODULE, NOT TWO COPIES (ADR-0030 commitment 1 +
// "What this makes harder"): the representation-coherence guarantee —
// "a stored fence and an ad-hoc query-param fence are byte-identical
// WKT and classify identically" — is a STANDING obligation, not a
// one-time check. The T5 query runs `ST_Contains(ST_GeomFromText(<wkt>,
// 4326), geometry)`; the stored fence's generated geometry column is
// `GENERATED ALWAYS AS (ST_GeomFromText("boundaryWkt", 4326)) STORED`.
// If the two paths built WKT from two copies of this parser, a future
// edit to one copy (tighten a bound, change closing logic, reformat a
// coordinate) would silently desynchronize stored fences from
// query-param fences — the exact drift ADR-0030 names as the hazard.
// One source makes the guarantee structural: there is nothing to keep
// in sync.
//
// THE PostGIS X,Y FOOT-GUN: WKT coordinate order is `lon lat` (X Y).
// `ST_MakePoint(lon, lat)`, `ST_GeomFromText("POLYGON((lon lat, …))")`,
// and this builder all observe that order; a swap anywhere would put
// latitude where longitude belongs and `ST_Contains` would misclassify.
// The geofence round-trip schema test (G1) and the telematics service
// tests both pin Kathmandu coordinates (lon 85.x, lat 27.x) where a
// swap is unmissable.

// The parsed polygon: a ready-to-bind WKT string plus the vertex count
// (for echoing back). The WKT is built from VALIDATED finite numbers and
// is meant to travel to Postgres as a single BOUND parameter
// (`ST_GeomFromText($1, 4326)` via `$queryRaw` / the generated column) —
// never string-interpolated into SQL, so there is no injection surface
// even though it is assembled here from caller input.
export interface ParsedPolygon {
  wkt: string;
  vertexCount: number;
}

// A linear ring needs at least 3 distinct vertices (a triangle); 1000 is
// a generous ceiling for a hand-drawn admin boundary that still bounds
// the WKT length and the geometry's vertex count. The same bounds the T5
// query fence used, now shared with the stored Geofence aggregate.
export const POLYGON_MIN_VERTICES = 3;
export const POLYGON_MAX_VERTICES = 1000;

/**
 * Parse `lon,lat;lon,lat;lon,lat` into a closed WKT `POLYGON((…))` ring.
 *
 * A Zod schema (a `z.string()` transform) so it composes into any schema
 * that accepts a polygon boundary: telematics' `GeofenceStatusQuerySchema`
 * uses `PolygonParam.optional()`; the geofence write schemas use it as a
 * required `boundary` field. Both therefore produce byte-identical WKT for
 * identical input (the coherence guarantee above).
 *
 * Validation, all surfaced as HTTP 400 by `ZodValidationPipe`:
 *   - 3–1000 vertices (`;`-separated);
 *   - each vertex is exactly `lon,lat`;
 *   - lon ∈ [-180, 180], lat ∈ [-90, 90], both finite (WGS84 ranges);
 *   - the ring is auto-closed (first vertex repeated last) if the caller
 *     did not close it, so a 3-vertex triangle is a valid request.
 */
export const PolygonParam = z
  .string()
  .trim()
  .transform((raw, ctx): ParsedPolygon => {
    const vertexStrs = raw
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (vertexStrs.length < POLYGON_MIN_VERTICES) {
      ctx.addIssue({
        code: "custom",
        message: `polygon needs at least ${POLYGON_MIN_VERTICES} vertices as "lon,lat;lon,lat;lon,lat".`,
      });
      return z.NEVER;
    }
    if (vertexStrs.length > POLYGON_MAX_VERTICES) {
      ctx.addIssue({
        code: "custom",
        message: `polygon must have at most ${POLYGON_MAX_VERTICES} vertices.`,
      });
      return z.NEVER;
    }
    const ring: [number, number][] = [];
    for (const vs of vertexStrs) {
      const parts = vs.split(",");
      if (parts.length !== 2) {
        ctx.addIssue({ code: "custom", message: `polygon vertex "${vs}" must be "lon,lat".` });
        return z.NEVER;
      }
      const lon = Number(parts[0]);
      const lat = Number(parts[1]);
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
        ctx.addIssue({
          code: "custom",
          message: `polygon vertex longitude "${parts[0]}" must be a number between -180 and 180.`,
        });
        return z.NEVER;
      }
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        ctx.addIssue({
          code: "custom",
          message: `polygon vertex latitude "${parts[1]}" must be a number between -90 and 90.`,
        });
        return z.NEVER;
      }
      ring.push([lon, lat]);
    }
    // A WKT linear ring must be closed (first vertex repeated last). Close
    // it here if the caller did not, so a 3-vertex triangle is valid.
    const [firstLon, firstLat] = ring[0];
    const [lastLon, lastLat] = ring[ring.length - 1];
    if (firstLon !== lastLon || firstLat !== lastLat) {
      ring.push([firstLon, firstLat]);
    }
    const coordList = ring.map(([lon, lat]) => `${lon} ${lat}`).join(", ");
    return { wkt: `POLYGON((${coordList}))`, vertexCount: ring.length };
  });
