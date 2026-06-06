// Web-side wire types for the per-vehicle cost report
// (GET /api/v1/reports/per-vehicle-cost). Mirrors the API response shape
// declared in apps/api/src/modules/reports/reports.service.ts
// (PerVehicleCostReport and friends) at the field level; dates arrive as
// strings over the JSON wire and money stays integer paisa end-to-end
// (CLAUDE.md §"Money & units"), formatted only at render via lib/money.
//
// Extracted into this co-located types.ts — the established per-slice
// convention (vehicles/types.ts, trips/types.ts, …) — now that a SECOND
// consumer beyond the report page needs the shape: the Home dashboard data
// layer (apps/web/src/lib/dashboard.ts) reuses these types for its
// "This-month cost" card rather than re-declaring them. The report page itself
// (apps/web/src/app/reports/per-vehicle-cost/page.tsx) still carries its own
// inline copy of this shape from iter 23; converging it onto these types is a
// tracked, zero-runtime cleanup (docs/tech-debt.md). Promoting to a shared
// @fleetco/shared package is deferred until a second app needs the type, per
// the sibling types.ts convention.

// One per-vehicle row: the fuel + expense paisa subtotals, their sum, and the
// per-bucket log counts. A vehicle with zero activity in the window does not
// appear (the service never zero-fills).
export interface PerVehicleCostRow {
  vehicleId: string;
  registrationNumber: string;
  fuelPaisa: number;
  expensePaisa: number;
  totalPaisa: number;
  fuelLogCount: number;
  expenseLogCount: number;
}

// The report's totals block — the sum of the VISIBLE per-vehicle rows. Excludes
// the company-level block, which the page surfaces as a separate sub-row, so
// "sum of the rows" matches the totals row bit-for-bit.
export interface PerVehicleCostTotals {
  fuelPaisa: number;
  expensePaisa: number;
  totalPaisa: number;
}

// Vehicle-agnostic expenses (ExpenseLog rows with no vehicleId) over the same
// window — e.g. a quarterly insurance premium. Independent of the vehicleId
// filter (these expenses belong to no single vehicle), so a single-vehicle
// report still surfaces them as context.
export interface CompanyLevelBlock {
  expensePaisa: number;
  expenseLogCount: number;
}

// GET /api/v1/reports/per-vehicle-cost response envelope.
export interface PerVehicleCostReport {
  // `from` / `to` echoed as YYYY-MM-DD strings (what the operator asked for),
  // not the midnight-coerced Date objects the service uses internally.
  from: string;
  to: string;
  rows: PerVehicleCostRow[];
  totals: PerVehicleCostTotals;
  companyLevel: CompanyLevelBlock;
}
