// Route-preview + map-prep pure helpers for the driver order-detail map
// (ADR-0047 c8/c9, W8). Everything here is pure and NATIVE-FREE so the jest
// suite pins it directly: the MapLibre island (trip-map.tsx) imports these, but
// a test never imports the island (the native module cannot load under jest-expo
// — the gps-task.ts precedent). This standalone app cannot import the API's
// types or the web's converters, so the slim shapes are declared here, mirroring
// apps/api routing + apps/web trips/[id].
//
import type { Feature, LineString } from "geojson";

// THE X=lon/Y=lat FOOT-GUN, isolated here: the API's route-preview endpoint
// (POST /api/v1/routing/route-preview) returns the polyline as [lat, lng] PAIRS
// (Leaflet-order, matching the web's map). MapLibre — like all GeoJSON — wants
// [lng, lat] (X, Y). The swap lives in one tested place (routeLineString) so the
// rest of the dispatch surface never re-derives it.

// Mirrors the API's RoutePreviewResult
// (apps/api/src/modules/routing/routing-provider.ts). `geometryLatLng` is
// [lat, lng] pairs; the first equals the origin, the last the destination.
// distanceMeters / durationSeconds are the estimate (a preview — see
// formatEtaLabel).
export interface RoutePreviewResult {
  geometryLatLng: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
}

// "45 min" / "1 h 30 min" — mirrors the web's formatDuration
// (apps/web/src/app/(app)/trips/[id]/page.tsx) so the two apps read identically.
// Kept in sync, not imported (the standalone app cannot reach the web package).
export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

// "32 km" / "3.2 km" — mirrors the web's formatDistanceKm (≥10 km rounds to a
// whole number; below that keeps one decimal, so a short haul still reads).
export function formatDistanceKm(meters: number): string {
  const km = meters / 1000;
  return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
}

// The muted preview label beside the map (DESIGN §"Trip dispatch"):
// "≈ 45 min · 32 km (estimated)". The "(estimated)" is load-bearing honesty —
// the estimate is a PREVIEW; the driver's authoritative turn-by-turn is the
// Navigate deep-link (W7), never this line (ADR-0047 c9).
export function formatEtaLabel(distanceMeters: number, durationSeconds: number): string {
  return `≈ ${formatDuration(durationSeconds)} · ${formatDistanceKm(distanceMeters)} (estimated)`;
}

// A pin the map draws — the lat/lng subset of a DriverSite. Declared locally so
// this pure module carries no dependency on the trip-domain type.
export interface MapPoint {
  latitude: number;
  longitude: number;
}

// Convert the API's [lat, lng] polyline into a GeoJSON LineString Feature in
// [lng, lat] order (the MapLibre/GeoJSON X,Y convention). Returns null for a
// degenerate (<2 points) geometry so the caller draws no line rather than a
// zero-length one. This is the single place the lat/lng swap happens.
export function routeLineString(
  geometryLatLng: [number, number][],
): Feature<LineString> | null {
  if (geometryLatLng.length < 2) return null;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: geometryLatLng.map(([lat, lng]) => [lng, lat]),
    },
  };
}

// A bounding box around the pickup + drop-off pins as MapLibre's LngLatBounds
// tuple [west, south, east, north] = [minLng, minLat, maxLng, maxLat], so the
// camera frames both pins on first load. Pure; the map fits to this once.
export function boundsForPins(a: MapPoint, b: MapPoint): [number, number, number, number] {
  const west = Math.min(a.longitude, b.longitude);
  const east = Math.max(a.longitude, b.longitude);
  const south = Math.min(a.latitude, b.latitude);
  const north = Math.max(a.latitude, b.latitude);
  return [west, south, east, north];
}
