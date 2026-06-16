// Driver-app trip domain types + pure PATCH-body builders (ADR-0034 D2). This
// standalone app cannot import the API's types, so the slim shapes a driver
// reads/writes are declared here, mirroring apps/api trips. The payload builders
// take `nowIso` as a parameter (not new Date()) so they stay pure and the unit
// tests are deterministic — the screen supplies new Date().toISOString().

export type TripStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

// The slim trip the driver screen renders — a subset of the API's TripListItem /
// TripDetail (the extra fields the API returns are simply ignored).
export interface DriverTrip {
  id: string;
  status: TripStatus;
  vehicle: { id: string; registrationNumber: string };
}

export interface TripStartPayload {
  status: "IN_PROGRESS";
  startedAt: string;
  startOdometerKm: number;
}

export interface TripStopPayload {
  status: "COMPLETED";
  endedAt: string;
  endOdometerKm: number;
}

// PLANNED → IN_PROGRESS: capture startedAt + the start odometer. Reuses the
// existing PATCH /trips/:id transition rules server-side (ADR-0034 c7).
export function tripStartPayload(startOdometerKm: number, nowIso: string): TripStartPayload {
  return { status: "IN_PROGRESS", startedAt: nowIso, startOdometerKm };
}

// IN_PROGRESS → COMPLETED: capture endedAt + the end odometer. The server bumps
// the vehicle's odometer on this transition.
export function tripStopPayload(endOdometerKm: number, nowIso: string): TripStopPayload {
  return { status: "COMPLETED", endedAt: nowIso, endOdometerKm };
}

// A driver's actionable trips: PLANNED (start) or IN_PROGRESS (stop). COMPLETED /
// CANCELLED trips carry no action.
export function isStartable(trip: DriverTrip): boolean {
  return trip.status === "PLANNED";
}

export function isStoppable(trip: DriverTrip): boolean {
  return trip.status === "IN_PROGRESS";
}
