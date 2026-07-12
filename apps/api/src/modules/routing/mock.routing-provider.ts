import { type LatLng, type RoutePreviewResult, RoutingProvider } from "./routing-provider";

/**
 * A no-network, fully deterministic {@link RoutingProvider} — the MockMailer /
 * MockLlmClient of the routing seam (ADR-0047 c9). It never opens a socket, so
 * it has two roles:
 *
 *   1. The dev / test / CI default the module factory binds whenever no live
 *      `ROUTING_PROVIDER` is selected — the build stays green with no API key
 *      and no coordinate egress.
 *   2. A test double: it RECORDS every call in {@link requests} (assert against
 *      it) and can be configured with a fixed `result` or a thrown error.
 *
 * The estimate is derived from the great-circle (haversine) distance between the
 * two points, inflated by a fixed road-winding factor, at a fixed assumed haul
 * speed — so identical inputs always yield an identical result. The geometry is
 * a gentle deterministic bézier bow between the endpoints so the preview reads
 * as a route on the map rather than a ruler-straight line, while remaining a
 * pure function of the two coordinates.
 */

const EARTH_RADIUS_M = 6_371_000;
/** Straight-line → on-road distance heuristic (roads wind; a preview, not truth). */
const ROAD_WINDING_FACTOR = 1.3;
/** ~40 km/h average loaded-haul speed on Nepal roads, in metres/second. */
const ASSUMED_SPEED_MPS = 11.1;
/** Polyline resolution — enough points to render the bow smoothly. */
const GEOMETRY_SEGMENTS = 24;
/** Perpendicular bow depth as a fraction of the endpoint delta (cosmetic only). */
const BOW_FRACTION = 0.08;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two points, in metres (haversine). Pure and
 * deterministic. Exported for the determinism/monotonicity tests.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A quadratic-bézier polyline from `a` to `b`, bowed to one side so it reads as
 * a route. Endpoints are exact (a bézier passes through P0 and P2). Pure.
 */
function bowedPolyline(a: LatLng, b: LatLng, segments: number): [number, number][] {
  const midLat = (a.lat + b.lat) / 2;
  const midLng = (a.lng + b.lng) / 2;
  const dLat = b.lat - a.lat;
  const dLng = b.lng - a.lng;
  // Control point: the midpoint offset perpendicular to the a→b direction
  // (perpendicular of (dLat, dLng) is (-dLng, dLat)).
  const cLat = midLat + -dLng * BOW_FRACTION;
  const cLng = midLng + dLat * BOW_FRACTION;

  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const mt = 1 - t;
    const lat = mt * mt * a.lat + 2 * mt * t * cLat + t * t * b.lat;
    const lng = mt * mt * a.lng + 2 * mt * t * cLng + t * t * b.lng;
    points.push([lat, lng]);
  }
  return points;
}

export class MockRoutingProvider extends RoutingProvider {
  /** Every `(origin, destination)` passed to {@link route}, in call order. */
  readonly requests: { origin: LatLng; destination: LatLng }[] = [];

  constructor(private readonly behavior: { result?: RoutePreviewResult; throwError?: Error } = {}) {
    super();
  }

  route(origin: LatLng, destination: LatLng): Promise<RoutePreviewResult> {
    this.requests.push({ origin, destination });
    if (this.behavior.throwError !== undefined) {
      return Promise.reject(this.behavior.throwError);
    }
    if (this.behavior.result !== undefined) {
      return Promise.resolve(this.behavior.result);
    }
    const straight = haversineMeters(origin, destination);
    const distanceMeters = Math.round(straight * ROAD_WINDING_FACTOR);
    const durationSeconds = Math.round(distanceMeters / ASSUMED_SPEED_MPS);
    return Promise.resolve({
      geometryLatLng: bowedPolyline(origin, destination, GEOMETRY_SEGMENTS),
      distanceMeters,
      durationSeconds,
    });
  }
}
