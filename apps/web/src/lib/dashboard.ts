// FleetCo Home daily-ops dashboard — the data layer (D1 of the Home-dashboard
// program). This module composes the dashboard's read model from EXISTING
// operational endpoints — no dashboard-specific backend, per DESIGN.md
// §"Surfaces" → "Home dashboard" ("The cards compose existing read endpoints
// fetched in parallel — no dashboard-specific endpoint"). It also exposes the
// pure, testable helpers that turn raw vehicle rows into the compliance
// roll-up the headline card paints. The page itself (loading/error states, the
// six cards, the quick-links strip) is built in D2 against the DashboardData
// this module returns.
//
// Two layers live here, deliberately in one file:
//
//   1. `loadDashboard()` — SERVER-ONLY. It calls `apiFetch`, which forwards the
//      request cookie via next/headers (lib/api.ts), so it must run in a server
//      component / server context, exactly like every list page's data fetch.
//      It fires the six read calls in parallel and shapes the result into
//      `DashboardData`. Not unit-tested (network I/O); exercised at SSR/build
//      time by D2's page.
//
//   2. The pure helpers (`vehicleComplianceState`, `rollUpCompliance`,
//      `currentMonthRange`) — no I/O, deterministic given `now`. ALL dashboard
//      correctness that can be pinned lives here and is covered by
//      test/dashboard.test.ts. They take `now: Date` explicitly so the tests
//      are timezone- and clock-deterministic (the same discipline
//      compliance.ts / nepali-date.ts follow).
//
// Imports are RELATIVE (not the app's usual `@/` alias) on purpose: the vitest
// config (apps/web/vitest.config.ts) resolves relative paths but not `@/`, and
// test/dashboard.test.ts imports THIS module to reach the pure helpers. Keeping
// every import relative is what lets the test load the module at all.

import { apiFetch } from "./api";
import { worstComplianceState, type ComplianceBadgeState } from "./compliance";
import type { ExpenseLogListItem } from "../app/expense-logs/types";
import type { FuelLogListItem } from "../app/fuel-logs/types";
import type {
  PerVehicleCostReport,
  PerVehicleCostTotals,
} from "../app/reports/per-vehicle-cost/types";
import type { TripListItem } from "../app/trips/types";
import type { Vehicle } from "../app/vehicles/types";

// ---------------------------------------------------------------------------
// Pure helpers — the testable core (test/dashboard.test.ts).
// ---------------------------------------------------------------------------

// The three Vehicle compliance-document expiry fields the roll-up reads. A
// `Pick` of the wire Vehicle type (reuse, never re-declare) so a Vehicle schema
// change ripples here, and so callers/tests can pass a minimal fixture rather
// than constructing a whole Vehicle.
export type VehicleComplianceFields = Pick<
  Vehicle,
  "bluebookExpiresAt" | "insuranceExpiresAt" | "routePermitExpiresAt"
>;

/**
 * The worst (most urgent) compliance state across a vehicle's three documents
 * — DESIGN.md §"Home dashboard" card 1: "a vehicle's state is the worst of its
 * three documents."
 *
 * A thin vehicle-object-shaped wrapper over `worstComplianceState`
 * (lib/compliance.ts): the worst-of precedence and the per-document 30-day /
 * UTC-calendar-day rule both live there and are never re-derived here. Kept as
 * a named helper because `rollUpCompliance` and the dashboard read a vehicle's
 * three named `*ExpiresAt` fields, not a bare array.
 *
 * @param vehicle the three `*ExpiresAt` fields (null when a document is unscanned)
 * @param now     the reference instant; compared by UTC calendar day (compliance.ts)
 */
export function vehicleComplianceState(
  vehicle: VehicleComplianceFields,
  now: Date,
): ComplianceBadgeState {
  return worstComplianceState(
    [vehicle.bluebookExpiresAt, vehicle.insuranceExpiresAt, vehicle.routePermitExpiresAt],
    now,
  );
}

/** The headline compliance card's counts (DESIGN.md §"Home dashboard" card 1). */
export interface ComplianceRollUp {
  /** Vehicles whose worst document state is `expired`. */
  expiredCount: number;
  /** Vehicles whose worst document state is `expiring-soon` (within 30 days). */
  expiringSoonCount: number;
  /** Vehicles scanned — bounded by the `take=200` ceiling (see loadDashboard). */
  total: number;
}

/**
 * Roll a fleet of vehicles up into the headline compliance counts. Each vehicle
 * is counted AT MOST ONCE, by its worst document state: a vehicle with one
 * expired and one expiring-soon document counts once as expired. Vehicles whose
 * worst state is `ok` or `none` count toward neither bucket (they carry no
 * lapsing document). `total` is the number of vehicles scanned.
 */
export function rollUpCompliance(
  vehicles: readonly VehicleComplianceFields[],
  now: Date,
): ComplianceRollUp {
  let expiredCount = 0;
  let expiringSoonCount = 0;
  for (const vehicle of vehicles) {
    const state = vehicleComplianceState(vehicle, now);
    if (state === "expired") expiredCount += 1;
    else if (state === "expiring-soon") expiringSoonCount += 1;
  }
  return { expiredCount, expiringSoonCount, total: vehicles.length };
}

// Format a Date as YYYY-MM-DD from its UTC calendar-day components. Timezone-
// independent by construction (reads getUTC*). Mirrors the reports service's
// `formatDateUtc` and the reports page's inline formatter.
function formatUtcDay(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The current calendar month as `[first-of-month, today]`, both `YYYY-MM-DD`
 * strings on the UTC calendar day. Feeds the per-vehicle cost report's required
 * `from` / `to` query params for the "This-month cost" card.
 *
 * Both bounds read the UTC calendar day (Date.UTC / getUTC*), so the range is
 * identical regardless of the server's timezone — the same UTC-day discipline
 * the report's own date filter, compliance.ts, and nepali-date.ts use. This
 * mirrors the STYLE of the reports page's private `defaultDateRange()` (UTC
 * getters, zero-padded) with ONE deliberate divergence: `to` is TODAY, not the
 * last day of the month, because the card reads "spend so far this month".
 * (Future dates in the month carry no logs, so the totals would be identical
 * either way; today is simply the more honest bound for a daily-ops snapshot.)
 */
export function currentMonthRange(now: Date): { from: string; to: string } {
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: formatUtcDay(firstOfMonth), to: formatUtcDay(now) };
}

// ---------------------------------------------------------------------------
// Read model — what loadDashboard() returns to D2's page.
// ---------------------------------------------------------------------------

/** The active-trips card's model: the in-progress trips (≤ 5) plus the full count. */
export interface DashboardActiveTrips {
  items: TripListItem[];
  total: number;
}

/** The this-month-cost card's model: the report window plus its paisa totals. */
export interface DashboardThisMonthCost {
  /** Window start, `YYYY-MM-DD` (first of the current month, UTC) — echoed by the report. */
  from: string;
  /** Window end, `YYYY-MM-DD` (today, UTC) — echoed by the report. */
  to: string;
  /** Fuel + expense paisa totals for the window (integer paisa, CLAUDE.md §Money). */
  totals: PerVehicleCostTotals;
}

/** The three fleet-count stats (DESIGN.md §"Home dashboard" card 6). */
export interface DashboardCounts {
  vehicles: number;
  drivers: number;
  activeTrips: number;
}

/**
 * The fully-composed dashboard read model returned by `loadDashboard()` and
 * consumed by D2's page. Every field is built from existing wire types (reused,
 * not re-declared); the compliance roll-up is computed server-side so the (up
 * to 200) vehicle rows never reach the browser.
 */
export interface DashboardData {
  compliance: ComplianceRollUp;
  activeTrips: DashboardActiveTrips;
  thisMonthCost: DashboardThisMonthCost;
  recentFuel: FuelLogListItem[];
  recentExpenses: ExpenseLogListItem[];
  counts: DashboardCounts;
}

// The shared `{ items, total, … }` list envelope every list endpoint returns.
// We type only the two fields the dashboard reads; the endpoints also echo
// skip / take / sortBy / sortDir, which we structurally ignore.
interface ListEnvelope<TItem> {
  items: TItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// loadDashboard() — server-only composition over existing endpoints.
// ---------------------------------------------------------------------------

// The active-trips list and the recent fuel/expense lists are each capped at
// five (DESIGN.md §"Home dashboard" cards 2, 4, 5).
const PREVIEW_TAKE = 5;

// The compliance-scan ceiling. The vehicles list endpoint clamps `take` at 200;
// the roll-up therefore scans at most 200 vehicles (see loadDashboard's
// undercount note).
const COMPLIANCE_SCAN_TAKE = 200;

/**
 * Load the Home dashboard's read model from existing endpoints.
 *
 * SERVER-ONLY: calls `apiFetch`, which forwards the request cookie via
 * next/headers; must run in a server component / server context (D2's page).
 *
 * Fires SIX reads in parallel via `Promise.all` (DESIGN.md §"Data & states":
 * the cards "compose existing read endpoints fetched in parallel"). Each
 * query param is verified against its controller's Zod schema:
 *
 *   1. vehicles?take=200                      — compliance-scan source + vehicle `total`
 *      (take ≤ 200 cap; reads each row's bluebook/insurance/routePermit expiry)
 *   2. trips?status=IN_PROGRESS&take=5
 *        &sortBy=startedAt&sortDir=desc        — active trips (≤5) + active `total`
 *      (IN_PROGRESS is the trips "in progress" status; startedAt is whitelisted)
 *   3. reports/per-vehicle-cost?from=…&to=…    — this-month fuel + expense paisa totals
 *      (from / to are required YYYY-MM-DD; this-month window via currentMonthRange)
 *   4. fuel-logs?sortBy=date&sortDir=desc&take=5     — recent fuel (≤5)
 *   5. expense-logs?sortBy=date&sortDir=desc&take=5  — recent expenses (≤5)
 *      (date is the whitelisted default sort on both log endpoints)
 *   6. drivers?take=1                          — driver count via `total` only
 *
 * The fleet-counts card REUSES the `total` from calls 1 and 2 (vehicles and
 * active trips), so only the driver count needs its own request — SIX calls,
 * not seven.
 *
 * The compliance roll-up is computed SERVER-SIDE here so the (up to 200)
 * vehicle rows never cross the wire to the browser; only the three counts do.
 *
 * UNDERCOUNT CEILING: the compliance scan reads at most `take=200` vehicles
 * (the list endpoint's hard cap). A fleet larger than 200 would undercount the
 * roll-up. An exact count for a >200-vehicle fleet needs a dedicated count
 * endpoint — out of scope under this program's zero-backend constraint, and
 * flagged as a future concern in DESIGN.md §"Home dashboard" ("a larger fleet
 * is a future dedicated-count concern").
 *
 * Errors propagate (no catch here): D2's page wraps this call in the
 * try/catch → redirect("/login") on `ApiError` 401 idiom every list page uses.
 */
export async function loadDashboard(): Promise<DashboardData> {
  const now = new Date();
  const { from, to } = currentMonthRange(now);

  // Every query value below is a controlled constant or a UTC `YYYY-MM-DD`
  // string from currentMonthRange — all URL-safe, no user input — so a plain
  // template literal is sufficient (no URLSearchParams escaping needed).
  const [vehicles, activeTrips, costReport, recentFuel, recentExpenses, drivers] =
    await Promise.all([
      apiFetch<ListEnvelope<Vehicle>>(`/api/v1/vehicles?take=${COMPLIANCE_SCAN_TAKE}`),
      apiFetch<ListEnvelope<TripListItem>>(
        `/api/v1/trips?status=IN_PROGRESS&take=${PREVIEW_TAKE}&sortBy=startedAt&sortDir=desc`,
      ),
      apiFetch<PerVehicleCostReport>(`/api/v1/reports/per-vehicle-cost?from=${from}&to=${to}`),
      apiFetch<ListEnvelope<FuelLogListItem>>(
        `/api/v1/fuel-logs?sortBy=date&sortDir=desc&take=${PREVIEW_TAKE}`,
      ),
      apiFetch<ListEnvelope<ExpenseLogListItem>>(
        `/api/v1/expense-logs?sortBy=date&sortDir=desc&take=${PREVIEW_TAKE}`,
      ),
      // Driver count only — `take=1` keeps the payload to a single row; we read
      // `total`, never the item, hence the `unknown` item type.
      apiFetch<ListEnvelope<unknown>>(`/api/v1/drivers?take=1`),
    ]);

  return {
    compliance: rollUpCompliance(vehicles.items, now),
    activeTrips: { items: activeTrips.items, total: activeTrips.total },
    thisMonthCost: { from: costReport.from, to: costReport.to, totals: costReport.totals },
    recentFuel: recentFuel.items,
    recentExpenses: recentExpenses.items,
    counts: {
      vehicles: vehicles.total,
      drivers: drivers.total,
      activeTrips: activeTrips.total,
    },
  };
}
