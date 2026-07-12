// Driver-app trip domain types + pure PATCH-body builders (ADR-0034 D2,
// extended for engine-hours by ADR-0036 B2). This standalone app cannot import
// the API's types, so the slim shapes a driver reads/writes are declared here,
// mirroring apps/api trips. The payload builders take `nowIso` as a parameter
// (not new Date()) so they stay pure and the unit tests are deterministic — the
// screen supplies new Date().toISOString().

// The trip lifecycle, mirrored from the API's TripStatus Prisma enum +
// TRIP_STATUSES (apps/api/src/modules/trips/trips.schemas.ts). ADR-0047 c1
// added OFFERED/ACCEPTED (the dispatch → acceptance states). This is one of the
// FIVE lock-step mirrors (the Prisma enum, the API schema list, the two web
// vocab lists, and this one) that must move together. The union derives from
// the array so the runtime list and the type cannot drift.
export const TRIP_STATUSES = [
  "PLANNED",
  "OFFERED",
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

export type TripStatus = (typeof TRIP_STATUSES)[number];

// Display labels (mirrors the web TRIP_STATUS_LABELS). The Record type makes
// the compiler require a label for every status; the unit test pins the key set
// at runtime as the mirror-consistency guard.
export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  PLANNED: "Planned",
  OFFERED: "Offered",
  ACCEPTED: "Accepted",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

// Haulage material (ADR-0047 c5), mirrored from the API's MaterialType Prisma
// enum. OTHER pairs with a free-text materialNote. MaterialType derives from
// the label map's keys so the two stay in lock-step (same one-source idiom as
// TripStatus above; mirrors the web MATERIAL_TYPE_LABELS).
export const MATERIAL_TYPE_LABELS = {
  SAND: "Sand",
  AGGREGATE: "Aggregate",
  GRAVEL: "Gravel",
  STONE: "Stone",
  BOULDER: "Boulder",
  SOIL: "Soil",
  BRICKS: "Bricks",
  OTHER: "Other",
} as const;

export type MaterialType = keyof typeof MATERIAL_TYPE_LABELS;

// Engine-hours meter classification (ADR-0036). Mirrors the API's MeterType. A
// vehicle is odometer-metered (km), engine-hours-metered, or BOTH; the driver
// screen branches its trip-start/stop capture on this so a pure ENGINE_HOURS
// excavator prompts for hours, not kilometers.
export type MeterType = "ODOMETER_KM" | "ENGINE_HOURS" | "BOTH";

export function meterIncludesOdometer(meterType: MeterType): boolean {
  return meterType === "ODOMETER_KM" || meterType === "BOTH";
}

export function meterIncludesHours(meterType: MeterType): boolean {
  return meterType === "ENGINE_HOURS" || meterType === "BOTH";
}

// A pickup / drop-off Site pin the driver reads off their OWN trip (ADR-0047
// c4 + c9/W7). name labels the endpoint; latitude/longitude feed the Navigate
// deep-link. The driver holds trips:* but NOT sites:*, so these ride the trip
// projection (LIST_SELECT/DETAIL_INCLUDE) — never a Sites API call. The Tier-2
// site contact is deliberately absent (the projection excludes it).
export interface DriverSite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

// The trip the driver screen renders — a subset of the API's TripListItem /
// TripDetail (the extra fields the API returns are simply ignored). `meterType`
// rides on the vehicle (the API's trip list projects it) so the screen knows
// which reading(s) to capture. ADR-0047 W7 adds the dispatch order fields the
// Requests card + order-detail view render — all nullable: a legacy/PLANNED
// trip carries no order, and the API always returns these keys (null when
// unset) on both the list (LIST_SELECT) and detail (DETAIL_INCLUDE) shapes.
export interface DriverTrip {
  id: string;
  status: TripStatus;
  vehicle: { id: string; registrationNumber: string; meterType: MeterType };
  materialType: MaterialType | null;
  materialNote: string | null;
  pickupSite: DriverSite | null;
  dropoffSite: DriverSite | null;
  consigneeName: string | null;
  consigneePhone: string | null;
  expectedLoadCount: number | null;
  specialInstructions: string | null;
  docketNumber: string | null;
}

export interface TripStartPayload {
  status: "IN_PROGRESS";
  startedAt: string;
  // Only the reading(s) the vehicle's meter calls for are present (ADR-0036 c7):
  // km for ODOMETER_KM, engine-hours for ENGINE_HOURS, both for BOTH.
  startOdometerKm?: number;
  startEngineHours?: number;
}

export interface TripStopPayload {
  status: "COMPLETED";
  endedAt: string;
  endOdometerKm?: number;
  endEngineHours?: number;
}

// OFFERED → ACCEPTED: the driver's Accept tap (ADR-0047 c8). Status alone — the
// server stamps acceptedAt and the order is already on the row (required at
// → OFFERED), so no order/timestamp fields ride the accept body.
export interface TripAcceptPayload {
  status: "ACCEPTED";
}

// Readings captured at a transition, in human units: odometer as whole km;
// engine-hours as a DECIMAL number of hours (e.g. 2500.5). The builders convert
// hours to integer tenths-of-an-hour (the wire unit) via hoursToTenths — the
// same Math.round half-up rule the web form's hoursToTenths and the fuel screen's
// litersToMl use, so the wire integer matches what the driver typed. Only the
// keys the screen passes (per the vehicle's meterType) end up on the wire.
export interface TripReadings {
  odometerKm?: number;
  engineHours?: number;
}

// Engine-hours decimal → integer tenths (deci-hours), mirroring the web's
// hoursToTenths and the fuel screen's litersToMl. Kept in lockstep, not imported
// (the standalone app cannot reach the web package).
export function hoursToTenths(hours: number): number {
  return Math.round(hours * 10);
}

// ACCEPTED → IN_PROGRESS: capture startedAt + the meter's start reading(s).
// (Post-ADR-0047 the driver starts from ACCEPTED, not PLANNED; PLANNED →
// IN_PROGRESS remains the API's admin/legacy path.) Reuses the existing PATCH
// /trips/:id transition rules server-side (ADR-0034 c7); the API requires the
// reading the vehicle's meter calls for.
export function tripStartPayload(readings: TripReadings, nowIso: string): TripStartPayload {
  const payload: TripStartPayload = { status: "IN_PROGRESS", startedAt: nowIso };
  if (readings.odometerKm !== undefined) {
    payload.startOdometerKm = readings.odometerKm;
  }
  if (readings.engineHours !== undefined) {
    payload.startEngineHours = hoursToTenths(readings.engineHours);
  }
  return payload;
}

// IN_PROGRESS → COMPLETED: capture endedAt + the meter's end reading(s). The
// server bumps the vehicle's odometer and/or engine-hours on this transition
// (ADR-0036 c5), each under its monotonic "once forward" rule.
export function tripStopPayload(readings: TripReadings, nowIso: string): TripStopPayload {
  const payload: TripStopPayload = { status: "COMPLETED", endedAt: nowIso };
  if (readings.odometerKm !== undefined) {
    payload.endOdometerKm = readings.odometerKm;
  }
  if (readings.engineHours !== undefined) {
    payload.endEngineHours = hoursToTenths(readings.engineHours);
  }
  return payload;
}

// A driver's actionable trips: ACCEPTED (start) or IN_PROGRESS (stop). Orders
// now arrive via OFFERED → ACCEPTED (ADR-0047 c7/c8), so Start appears once the
// driver has ACCEPTED, NOT at PLANNED — the one real code break this program
// carries (a REPLACEMENT, not a widening; PLANNED → IN_PROGRESS stays legal in
// the API matrix as the admin/legacy path, but the driver flow is
// OFFERED → ACCEPTED → start). PLANNED/OFFERED/COMPLETED/CANCELLED carry no
// start action here.
export function isStartable(trip: DriverTrip): boolean {
  return trip.status === "ACCEPTED";
}

export function isStoppable(trip: DriverTrip): boolean {
  return trip.status === "IN_PROGRESS";
}

// Build a Google Maps "directions" deep-link to a pin (ADR-0047 c9). The
// driver's Navigate button hands this to Linking.openURL, opening the device's
// Google Maps for live-traffic turn-by-turn + ETA — the real Google-Maps
// experience with no API key, no per-request cost, and no in-app nav engine.
// The universal https form works on BOTH Android and iOS (google.navigation: /
// geo: are Android-only alternatives). Latitude comes FIRST in Google's
// destination= param — the X=lon/Y=lat foot-gun: a Site's latitude/longitude
// are separate scalars, so the pin's latitude is placed first, longitude second.
export function navigateUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`;
}
