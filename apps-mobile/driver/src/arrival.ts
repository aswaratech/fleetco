// Driver "am I at the site?" arrival status — pure, native-free helpers for the
// D6 geofence-context view (ADR-0035 D6 / ADR-0034 c6). The driver app reads the
// DERIVED geofence status of its OWN vehicle against a proximity CIRCLE around
// the trip's pickup / drop-off Site pin (the server runs ST_DWithin; there is NO
// stored fence per site — Site.geofenceId is deferred, ADR-0047 c4/c11, and a
// DRIVER does not hold geofences:read). Kept pure and native-free so jest pins it
// directly (the routing.ts precedent); the api client + OrderDetail consume it.

// How close (metres) the vehicle's latest fix must be to a Site pin to read "at
// the site". A build-now-flag-here PROVISIONAL constant (the GPS-retention /
// maintenance-window / ingest-slack pattern): 150 m is a sensible depot/crusher
// approach radius — tune with pilot data, never silently. The server bounds
// radiusMeters to [1, 500_000], so this stays comfortably in range.
export const ARRIVAL_RADIUS_M = 150;

// The lat/lng subset of a DriverSite this module needs — declared locally so the
// pure helper carries no trip-domain dependency (the routing.ts MapPoint idiom).
export interface SitePoint {
  latitude: number;
  longitude: number;
}

// The slim shape of the API's GeofenceStatusResponse the arrival view consumes
// (apps/api .../telematics.controller.ts GeofenceStatusResponse). `inside` is
// null when the vehicle has no GPS fix yet (nothing to classify); `latestFixAt`
// is the fix time it was evaluated against (or null). The status reflects the
// vehicle's LAST reported fix (server-side), not the phone's instant location.
export interface ArrivalStatus {
  inside: boolean | null;
  latestFixAt: string | null;
}

// The circle query params for GET …/geofence-status (centre = the Site pin,
// radius = ARRIVAL_RADIUS_M). One place so the call site and its test agree; the
// API's Zod schema coerces the numeric values from the query string.
export function arrivalQuery(site: SitePoint): {
  centerLatitude: number;
  centerLongitude: number;
  radiusMeters: number;
} {
  return {
    centerLatitude: site.latitude,
    centerLongitude: site.longitude,
    radiusMeters: ARRIVAL_RADIUS_M,
  };
}

// The three arrival states, derived from the API's `inside` boolean:
//   • "arrived" — the vehicle's latest fix is inside the site radius.
//   • "away"    — a fix exists but is outside the radius.
//   • "unknown" — no fix yet (inside === null) OR the read failed (status null).
// "unknown" is deliberately NOT "away": on a gappy phone producer, absence of a
// fix must not read as a false "not arrived".
export type ArrivalState = "arrived" | "away" | "unknown";

export function arrivalState(status: ArrivalStatus | null): ArrivalState {
  if (!status || status.inside === null) return "unknown";
  return status.inside ? "arrived" : "away";
}

// The short driver-facing text for each state. Endpoint-agnostic — the row it
// renders in already labels which endpoint (Pickup / Drop-off).
export function arrivalStateText(state: ArrivalState): string {
  switch (state) {
    case "arrived":
      return "Arrived";
    case "away":
      return "Not yet";
    case "unknown":
      return "Location unknown";
  }
}
