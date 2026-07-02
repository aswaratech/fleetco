// Web-side view of the M7 latest-positions wire shape (ADR-0042 c10 —
// apps/api/src/modules/telematics/telematics.service.ts, LatestPosition)
// plus the slim shapes the /map page passes its client island. Dates arrive
// as ISO strings over the JSON wire. Inlined per the same convention as the
// other per-slice types.ts modules.

export interface LatestPositionFix {
  latitude: number;
  longitude: number;
  /** Stored m/s; the popup converts to km/h at render. */
  speed: number | null;
  heading: number | null;
  ignition: boolean | null;
  timestamp: string;
}

export interface LatestPosition {
  vehicleId: string;
  registrationNumber: string;
  kind: string;
  status: string;
  /** null = no ping ever recorded for this vehicle. */
  fix: LatestPositionFix | null;
  /** Server-computed (never the client clock — the M9 honesty rule). */
  fixAgeSeconds: number | null;
}

export interface LatestPositionsResponse {
  positions: LatestPosition[];
}

/** A DEPOT geofence reduced to what the yard overlay needs. */
export interface DepotFence {
  id: string;
  name: string;
  boundaryWkt: string;
}
