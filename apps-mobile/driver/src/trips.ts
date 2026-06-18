// Driver-app trip domain types + pure PATCH-body builders (ADR-0034 D2,
// extended for engine-hours by ADR-0036 B2). This standalone app cannot import
// the API's types, so the slim shapes a driver reads/writes are declared here,
// mirroring apps/api trips. The payload builders take `nowIso` as a parameter
// (not new Date()) so they stay pure and the unit tests are deterministic — the
// screen supplies new Date().toISOString().

export type TripStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

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

// The slim trip the driver screen renders — a subset of the API's TripListItem /
// TripDetail (the extra fields the API returns are simply ignored). `meterType`
// rides on the vehicle (the API's trip list projects it) so the screen knows
// which reading(s) to capture.
export interface DriverTrip {
  id: string;
  status: TripStatus;
  vehicle: { id: string; registrationNumber: string; meterType: MeterType };
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

// PLANNED → IN_PROGRESS: capture startedAt + the meter's start reading(s).
// Reuses the existing PATCH /trips/:id transition rules server-side (ADR-0034
// c7); the API requires the reading the vehicle's meter calls for.
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

// A driver's actionable trips: PLANNED (start) or IN_PROGRESS (stop). COMPLETED /
// CANCELLED trips carry no action.
export function isStartable(trip: DriverTrip): boolean {
  return trip.status === "PLANNED";
}

export function isStoppable(trip: DriverTrip): boolean {
  return trip.status === "IN_PROGRESS";
}
