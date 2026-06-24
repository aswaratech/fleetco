// Web-side wire types for the per-vehicle fuel-efficiency report
// (GET /api/v1/reports/per-vehicle-efficiency — Reports v2, the A2 slice).
// Mirrors the API response shape declared in
// apps/api/src/modules/reports/reports.service.ts
// (PerVehicleEfficiencyReport / PerVehicleEfficiencyRow /
// PerVehicleEfficiencyTotals / EfficiencyFlag) at the field level. Dates
// arrive as strings over the JSON wire; money stays integer paisa and fuel
// volume stays integer milliliters end-to-end (CLAUDE.md §"Money & units"),
// formatted only at render via lib/money + lib/units. The two efficiency
// ratios (kmPerLitre, nprPerKm) are display-only figures the service computes
// at the response edge and never stores; they are non-integer at that edge
// and `null` at the documented boundaries (see per-field notes below).
//
// Co-located types.ts is the established per-slice convention
// (vehicles/types.ts, trips/types.ts, reports/per-vehicle-cost/types.ts, …);
// the cost report extracted its wire type here once the Home dashboard became
// a second consumer, and this surface follows the same move from day one.
// Promoting to a shared @fleetco/shared package is deferred until a second app
// needs the type, per that convention.

// The efficiency flag for a per-vehicle row, mirroring the API's
// `EfficiencyFlag` union. The service classifies this window's km/L against
// the same vehicle's prior equal-length window:
//   - `degraded`          km/L fell beyond the service's deviation threshold
//   - `improved`          km/L rose beyond the threshold
//   - `normal`            within the threshold (rendered as no badge — the
//                         absence is the signal)
//   - `insufficient-data` too little distance or fuel in the window to compute
//                         a trustworthy ratio (km/L em-dashes)
export type EfficiencyFlag = "degraded" | "improved" | "normal" | "insufficient-data";

// One per-vehicle row. A vehicle with zero activity (no completed-trip
// distance and no fuel) in the window does not appear — the service never
// zero-fills.
export interface PerVehicleEfficiencyRow {
  vehicleId: string;
  registrationNumber: string;
  // Σ(endOdometerKm − startOdometerKm) over COMPLETED trips in-window — the
  // system-of-record distance (ADR-0003), NOT the non-monotonic fuel-log
  // odometer. Integer kilometres.
  distanceKm: number;
  // Σ litersMl over in-window fuel logs (integer milliliters; ÷ 1000 at
  // render via formatLiters).
  litresMl: number;
  // distanceKm × 1000 / litresMl — the efficiency ratio (display-only, never
  // stored). `null` exactly when the row flags `insufficient-data`, rendered
  // as an em-dash.
  kmPerLitre: number | null;
  // fuelPaisa / distanceKm — fuel cost per kilometre, in PAISA per km
  // (display-only). `null` when distanceKm is 0 (no divide-by-zero); rendered
  // via formatNpr, em-dash when null.
  nprPerKm: number | null;
  // Σ totalCostPaisa over in-window fuel logs (integer paisa).
  fuelPaisa: number;
  flag: EfficiencyFlag;
}

// The report's fleet totals — the sum of the visible per-vehicle rows, with
// the two ratios recomputed at the fleet level. There is no companyLevel
// block on this report (unlike the cost report): both inputs (completed trips
// and fuel logs) are always vehicle-bound, so every figure belongs to a
// vehicle.
export interface PerVehicleEfficiencyTotals {
  distanceKm: number;
  litresMl: number;
  fuelPaisa: number;
  // Fleet km/L (display ratio at the edge); `null` when litresMl is 0.
  kmPerLitre: number | null;
  // Fleet NPR/km in paisa-per-km (display ratio at the edge); `null` when
  // distanceKm is 0.
  nprPerKm: number | null;
}

// GET /api/v1/reports/per-vehicle-efficiency response envelope.
export interface PerVehicleEfficiencyReport {
  // `from` / `to` echoed as YYYY-MM-DD strings (what the operator asked for),
  // not the midnight-coerced Date objects the service uses internally — so the
  // page can re-render its date inputs from the response without re-parsing
  // the URL.
  from: string;
  to: string;
  rows: PerVehicleEfficiencyRow[];
  totals: PerVehicleEfficiencyTotals;
}
