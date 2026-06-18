import { Injectable } from "@nestjs/common";
import { TripStatus } from "@prisma/client";

// PrismaService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime so the DI
// container can resolve it. Same eslint override every other
// vertical-slice service applies.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// ReportsService — read-only aggregation surface over Fuel logs
// (iter 19/20) and Expense logs (iter 21/22). The iter-23 ticket
// scopes the module to one report: per-vehicle cost over a date
// range. Future report slices (per-vehicle profit-and-loss,
// per-driver utilisation) will extend this service rather than
// spawning a parallel module — same pattern Vehicles / Drivers / etc
// follow when adding stats methods to an existing module.
//
// Design notes that the rest of the file relies on:
//
//   1. The report is read-only and aggregation-only. No write path,
//      no materialized view, no Redis caching layer in iter 23 — the
//      two `groupBy` queries Postgres runs are both backed by the
//      `(date desc)` partial indexes on `fuel_log` and `expense_log`
//      and run sub-millisecond on the seed dataset; revisiting this
//      with a materialized view is a Phase-2 concern when the
//      dataset grows past the index's working set.
//
//   2. Money stays as integer paisa end-to-end per CLAUDE.md
//      §"Money & units". The service sums paisa with Number
//      arithmetic — JavaScript's safe-integer range
//      (2^53 - 1 ≈ 9.007e15 paisa ≈ NPR 90 trillion) comfortably
//      exceeds any plausible Phase-1 total. If a future iter wants
//      to push the wire over the safe-integer boundary we will
//      switch to BigInt; the schema's per-row ceiling
//      (10_000_000_000 paisa = NPR 100M per row) means we would
//      need ~900,000 maxed-out rows for one vehicle in one window
//      to even approach the boundary.
//
//   3. The date filter applies to the `date` column on both
//      FuelLog and ExpenseLog — the operator's reporting date, NOT
//      the `createdAt` column. This is the third of the three
//      expense-log-specific rules the iter-23 ticket calls out
//      (rule #3) and it survives unchanged from Fuel logs: when
//      the operator generates a report for "February 2026", they
//      mean "expenses dated within February", not "expenses
//      entered within February" — the data-entry latency on the
//      paper receipts they're transcribing routinely runs into
//      weeks.
//
//   4. Vehicle-agnostic expenses (`vehicleId IS NULL` on
//      ExpenseLog — rule #2 from iter 22, carried into iter 23 as
//      rule #2) live in a separate `companyLevel` block on the
//      response, never in a per-vehicle row. A vehicle filter
//      narrows the per-vehicle rows but does NOT zero the
//      company-level block — those expenses are not attributable
//      to any single vehicle, so filtering by one vehicle doesn't
//      hide them.
//
//   5. `amountPaisa` is summed verbatim (rule #1 from iter 22) —
//      no derivation, no per-row weighting. The `groupBy` with
//      `_sum.amountPaisa` does the summation in the database; we
//      coerce the result to a JavaScript number on the way out.
//
//   6. A vehicle with zero activity in the window does NOT appear
//      in the response — the iter-23 ticket spells this out
//      explicitly. Implementation: the two `groupBy` queries
//      return only vehicleIds that have at least one matching
//      row, so the merged map's keys are already filtered to
//      "has activity". We never enumerate the full Vehicle table.

export interface PerVehicleCostRow {
  vehicleId: string;
  registrationNumber: string;
  fuelPaisa: number;
  expensePaisa: number;
  totalPaisa: number;
  fuelLogCount: number;
  expenseLogCount: number;
}

export interface CompanyLevelBlock {
  // Vehicle-agnostic expenses (ExpenseLog rows where vehicleId IS
  // NULL) over the same date range. FuelLog has no equivalent —
  // every fuel log has a required vehicleId — so the
  // companyLevel block carries an expense bucket only. Naming it
  // explicitly `expensePaisa` (rather than `paisa`) leaves room
  // for a future bucket (e.g., overhead-allocated maintenance)
  // without breaking the wire shape.
  expensePaisa: number;
  expenseLogCount: number;
}

export interface PerVehicleCostTotals {
  fuelPaisa: number;
  expensePaisa: number;
  totalPaisa: number;
}

export interface PerVehicleCostReport {
  // Echo the query's `from` and `to` as ISO date strings (YYYY-MM-DD)
  // so the web page can re-render its date inputs from the response
  // without re-parsing the URL. The wire convention is "what the
  // operator asked for", not the midnight-coerced Date objects the
  // service uses internally.
  from: string;
  to: string;
  rows: PerVehicleCostRow[];
  totals: PerVehicleCostTotals;
  companyLevel: CompanyLevelBlock;
}

/**
 * Build the inclusive-from / inclusive-through-end-of-day date range
 * the Prisma `where { date: { gte, lte } }` clause expects.
 *
 * The schema parses `from` / `to` as YYYY-MM-DD strings at UTC
 * midnight (00:00:00.000Z). The Prisma WHERE on the `date` column
 * uses `gte` and `lte` (NOT `lt`): for `to` to be INCLUSIVE of
 * end-of-day on the supplied calendar date, we shift `to` forward by
 * (one day - one millisecond) so a row dated 2026-02-28T23:59:59.999Z
 * is still inside the window but a row dated 2026-03-01T00:00:00.000Z
 * is not.
 *
 * Why a one-millisecond fudge instead of `lt nextDayMidnight`:
 *
 *   - `lte` keeps the intent symmetric with `gte` (both are
 *     inclusive bounds); the read of the WHERE clause is
 *     immediately obvious without consulting the helper.
 *
 *   - Postgres `timestamp(3)` has millisecond resolution; rounding
 *     down to the last representable instant of the day fits
 *     exactly. A nanosecond-resolution database would require a
 *     different fudge; we revisit if that ever happens.
 *
 * Exported for the test suite — the date-boundary tests assert the
 * one-millisecond-before-midnight invariant directly.
 */
export function buildDateRange(from: Date, to: Date): { gte: Date; lte: Date } {
  const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
  return {
    gte: from,
    lte: new Date(to.getTime() + MILLIS_PER_DAY - 1),
  };
}

/**
 * Format a Date as a YYYY-MM-DD string in UTC. Used on the response
 * envelope's `from` / `to` echoes so the web client can re-render
 * its date inputs without re-parsing the URL.
 *
 * Exported for the test suite — boundary tests verify the formatter
 * is the inverse of the schema's parse.
 */
export function formatDateUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ───────────────────────────────────────────────────────────────────
// Per-vehicle fuel-efficiency report (Reports v2, A2).
//
// This completes the "fuel efficiency" deliverable named for Reports
// v1 in docs/product/roadmap.md (§"Phase 1 — The Spine") that iter-23
// left unshipped: iter-23 shipped the cost half only (getPerVehicleCost
// above); this is the efficiency half, landing as Reports v2 in the
// Phase-2 window — deferred Phase-1 daily-use polish, the same category
// as the Home dashboard and the BS-date work. The design contract is
// DESIGN.md §"Surfaces" → "Per-vehicle fuel-efficiency report" (A1).
//
// It extends THIS service along the seam the file's top docstring
// anticipates ("future report slices will extend this service rather
// than spawning a parallel module"). No new ADR, dependency, schema /
// migration, capability, or ReportsModule change: every input already
// exists.
//
// Modeling decisions the rest of the slice relies on:
//
//   1. DISTANCE is the system-of-record figure — Σ(endOdometerKm −
//      startOdometerKm) over COMPLETED trips (ADR-0003: the Trip
//      aggregate owns distance; the Trip → Vehicle odometer auto-update
//      already maintains it). It is NOT the fuel log's
//      `odometerReadingKm`, which is nullable and non-monotonic by
//      recorded decision (docs/tech-debt.md, Paid-off) and would inject
//      noise. A COMPLETED trip is GUARANTEED (trips.schemas.ts
//      validateTripStatusFields, enforced on create AND patch) to carry
//      all four start/end fields with endOdometerKm ≥ startOdometerKm,
//      so every per-trip delta is a non-negative integer and
//      Σ(end − start) = Σend − Σstart. We compute it with a single
//      `groupBy` `_sum` over both odometer columns — the same
//      database-side aggregation getPerVehicleCost uses for money,
//      staying entirely in integer space.
//
//   2. A completed trip's distance is attributed to the window by its
//      `endedAt` — the instant the trip completes, the end odometer is
//      read, and the Vehicle.odometerCurrentKm auto-update fires. This
//      mirrors the cost report's use of the operator's reporting `date`
//      (not `createdAt`): the report window is "when the work
//      happened", and a completed trip's distance is realized at
//      `endedAt`. A multi-day trip straddling the boundary lands in the
//      window of its completion. (`endedAt` is non-null for every
//      COMPLETED trip, so it is always a safe filter column.)
//
//   3. CONSUMPTION is Σ litersMl and Σ totalCostPaisa over FuelLog rows
//      whose reporting `date` is in-window — the same `date` column
//      (not `createdAt`) and the same inclusive-through-end-of-day
//      buildDateRange the cost report uses. FuelLog.vehicleId is always
//      non-null, so (unlike the cost report's ExpenseLog) there is NO
//      companyLevel block: both inputs (Trip, FuelLog) are always
//      vehicle-bound, so every figure belongs to a vehicle.
//
//   4. km/L and NPR/km are DISPLAY RATIOS, computed at the edge and
//      NEVER stored: km/L = distanceKm × 1000 / litresMl (litres =
//      mL / 1000 folded in), NPR/km = fuelPaisa / distanceKm. Integers
//      stay integers in storage and in the flag math (below); only
//      these two ratios are non-integer, and only at the response edge.
//      km/L is null on `insufficient-data`; NPR/km is null only when
//      distanceKm is 0 (no divide-by-zero).
//
//   5. The FLAG compares this window's km/L against the SAME vehicle's
//      prior equal-length window (priorEqualWindow). The comparison is
//      exact integer cross-multiplication (classifyEfficiency) so the
//      ±15% boundary is deterministic regardless of floating-point
//      representation — a "trend, not forensic meter" report still
//      deserves a boundary that does not flicker.
//
//   6. HONEST FRAMING (carried in the PR and lightly in the UI per the
//      DESIGN.md coverage note): with a nullable / non-monotonic fuel
//      odometer and ~15–20% dashboard drift, this is a reliable fleet /
//      period-level km/L TREND + exception flag, not a forensic
//      per-fill meter. A `degraded` flag means "investigate", not
//      "proven theft". It self-sharpens once the driver app makes
//      odometer-at-fill routine.

/** The efficiency flag for a per-vehicle row. See classifyEfficiency. */
export type EfficiencyFlag = "degraded" | "improved" | "normal" | "insufficient-data";

/**
 * Deviation threshold (percent) for the degraded / improved flags: a
 * window whose km/L differs from its prior-equal-window baseline by MORE
 * than this fraction is flagged. Named (not inlined) per the A2 ticket;
 * DESIGN.md states the exact threshold is "the report service's
 * constants, not design law".
 */
export const EFFICIENCY_DEVIATION_PERCENT = 15;

/**
 * Insufficient-data distance floor (kilometres): a window with less
 * completed-trip distance than this cannot produce a km/L worth
 * trusting, so the row flags `insufficient-data` and its km/L cell
 * em-dashes. Paired with the 0-litre guard in classifyEfficiency (which
 * also prevents divide-by-zero). Named per the A2 ticket.
 */
export const INSUFFICIENT_DATA_MIN_DISTANCE_KM = 50;

export interface PerVehicleEfficiencyRow {
  vehicleId: string;
  registrationNumber: string;
  /** Σ(endOdometerKm − startOdometerKm) over COMPLETED trips in-window. */
  distanceKm: number;
  /** Σ litersMl over in-window FuelLogs (integer mL; display ÷ 1000). */
  litresMl: number;
  /** distanceKm × 1000 / litresMl; null on `insufficient-data`. */
  kmPerLitre: number | null;
  /** fuelPaisa / distanceKm (paisa per km); null when distanceKm is 0. */
  nprPerKm: number | null;
  /** Σ totalCostPaisa over in-window FuelLogs (integer paisa). */
  fuelPaisa: number;
  flag: EfficiencyFlag;
}

export interface PerVehicleEfficiencyTotals {
  distanceKm: number;
  litresMl: number;
  fuelPaisa: number;
  /** Fleet km/L (display ratio at the edge); null when litresMl is 0. */
  kmPerLitre: number | null;
  /** Fleet NPR/km (display ratio at the edge); null when distanceKm is 0. */
  nprPerKm: number | null;
}

export interface PerVehicleEfficiencyReport {
  // Echo the query's `from` / `to` as YYYY-MM-DD strings, exactly as
  // PerVehicleCostReport does, so the web page can re-render its date
  // inputs from the response without re-parsing the URL. There is no
  // companyLevel block here (see modeling note 3).
  from: string;
  to: string;
  rows: PerVehicleEfficiencyRow[];
  totals: PerVehicleEfficiencyTotals;
}

/**
 * The window of equal length immediately preceding [from, to] — the
 * per-vehicle efficiency baseline. Both inputs are UTC-midnight Date
 * objects (as the schema parses them); the returned bounds are the same
 * shape, so buildDateRange turns them into the inclusive-through-end-of-
 * day Prisma filter exactly as for the current window.
 *
 * For a 28-day window [Feb 1, Feb 28] the prior window is [Jan 4, Jan
 * 31] (28 days ending the day before `from`). Exported for the test
 * suite — the baseline math is pinned directly.
 */
export function priorEqualWindow(from: Date, to: Date): { from: Date; to: Date } {
  const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
  // [from, to] is inclusive on both ends; its length in whole days is
  // the midnight-to-midnight gap plus one. UTC math has no DST, so the
  // gap is an exact multiple of a day; Math.round is belt-and-braces.
  const spanDays = Math.round((to.getTime() - from.getTime()) / MILLIS_PER_DAY) + 1;
  return {
    from: new Date(from.getTime() - spanDays * MILLIS_PER_DAY),
    to: new Date(from.getTime() - MILLIS_PER_DAY),
  };
}

/** A window's efficiency inputs: distance travelled and fuel burned. */
interface EfficiencyBasis {
  distanceKm: number;
  litresMl: number;
}

/**
 * Classify a vehicle's current-window efficiency against its baseline.
 *
 *   - `insufficient-data` when the CURRENT window has too little
 *     distance (< INSUFFICIENT_DATA_MIN_DISTANCE_KM) or no fuel
 *     (litresMl ≤ 0) — no trustworthy ratio, and the 0-litre case also
 *     guards the divide. Checked first: a vehicle we cannot measure is
 *     reported as such regardless of any baseline.
 *   - `normal` when the current window is measurable but the BASELINE
 *     is not (a new vehicle, or a quiet prior period) — we have a km/L
 *     to show but nothing to compare it against, so we stay quiet (no
 *     badge). DESIGN.md: "the absence of a badge is itself the signal".
 *   - else compare current km/L against baseline km/L:
 *       degraded  current < baseline × (100 − DEV)/100   (worse by > DEV%)
 *       improved  current > baseline × (100 + DEV)/100   (better by > DEV%)
 *       normal    within ±DEV%.
 *
 * km/L = distanceKm × 1000 / litresMl. Rather than divide (and inherit
 * floating-point fuzz at exactly ±DEV%), we cross-multiply into a pure
 * integer comparison — the common ×1000 cancels:
 *     current km/L  <  baseline km/L × f/100
 *  ⟺  Cd/Cl  <  (Bd/Bl) × f/100
 *  ⟺  Cd × Bl × 100  <  Bd × Cl × f          (all terms ≥ 0)
 * with f = 100 − DEV for degraded and 100 + DEV for improved. Every term
 * is a non-negative integer (distances km, litres mL, percents), so the
 * boundary is exact. Phase-1/2 per-vehicle windows keep the products
 * near 1e12 — comfortably inside Number.MAX_SAFE_INTEGER (~9.007e15); a
 * pathological multi-year single-vehicle window would switch to BigInt,
 * the same escape hatch getPerVehicleCost documents.
 */
function classifyEfficiency(current: EfficiencyBasis, baseline: EfficiencyBasis): EfficiencyFlag {
  if (current.distanceKm < INSUFFICIENT_DATA_MIN_DISTANCE_KM || current.litresMl <= 0) {
    return "insufficient-data";
  }
  if (baseline.distanceKm < INSUFFICIENT_DATA_MIN_DISTANCE_KM || baseline.litresMl <= 0) {
    return "normal";
  }
  const currentScaled = current.distanceKm * baseline.litresMl * 100;
  const degradedBound =
    baseline.distanceKm * current.litresMl * (100 - EFFICIENCY_DEVIATION_PERCENT);
  const improvedBound =
    baseline.distanceKm * current.litresMl * (100 + EFFICIENCY_DEVIATION_PERCENT);
  if (currentScaled < degradedBound) return "degraded";
  if (currentScaled > improvedBound) return "improved";
  return "normal";
}

/**
 * Deterministic row order: the exception flag first (degraded →
 * improved → normal → insufficient-data) so the vehicles that need a
 * look sit at the top, then registrationNumber ascending so ties do not
 * shuffle between refreshes. Pinned by a test.
 */
const FLAG_SORT_ORDER: Record<EfficiencyFlag, number> = {
  degraded: 0,
  improved: 1,
  normal: 2,
  "insufficient-data": 3,
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the per-vehicle cost report for the supplied date range
   * (and optional vehicle filter). Implementation plan:
   *
   *   1. Two `groupBy` aggregations, both filtered by `date`
   *      between `from` and `to` (inclusive both sides):
   *
   *        - FuelLog grouped by `vehicleId`, `_sum.amountPaisa`,
   *          `_count.id` — every FuelLog has a non-null
   *          `vehicleId`, so no IS-NULL handling needed.
   *
   *        - ExpenseLog grouped by `vehicleId`, `_sum.amountPaisa`,
   *          `_count.id` — vehicleId is nullable on ExpenseLog, so
   *          the groupBy returns one bucket per vehicleId plus
   *          (potentially) one `vehicleId: null` bucket that we
   *          route to the response's `companyLevel` block.
   *
   *      When the optional `vehicleId` filter is set, the per-
   *      vehicle WHERE clauses gain an equality on vehicleId, but
   *      the company-level block is computed against an unfiltered
   *      (over vehicleId) WHERE — the company-level expenses don't
   *      belong to any vehicle and so the filter doesn't apply to
   *      them. This is a deliberate design choice spelled out in
   *      the iter-23 ticket: "Vehicle-agnostic expense logs are
   *      excluded from per-vehicle rows but counted in a separate
   *      companyLevel block in the response." When the operator
   *      narrows to one vehicle they still want to see "what else
   *      did the company spend that month" as context.
   *
   *   2. Merge the two `Map<vehicleId, { fuelPaisa, expensePaisa,
   *      fuelLogCount, expenseLogCount }>` views by union of keys.
   *      A vehicle with only fuel logs has `expensePaisa: 0,
   *      expenseLogCount: 0`; mirror for only-expenses. A vehicle
   *      with neither does not appear (its key is in neither
   *      groupBy result).
   *
   *   3. Join to Vehicle for the registration number: one batched
   *      `findMany({ where: { id: { in: [...keys] } } })`. Vehicles
   *      that were soft-deleted between the FK validation and the
   *      report run (vanishingly rare given the Restrict policy on
   *      every parent FK in this codebase) are dropped from the
   *      output — they have no registration number to display.
   *
   *   4. Sort rows by `totalPaisa` desc; secondary tiebreaker on
   *      `registrationNumber` asc so two vehicles that tied in
   *      cost have a stable ordering across re-runs (and the
   *      operator's eye doesn't jump on every refresh).
   *
   *   5. Roll the rows up into the response's `totals` block. The
   *      `totals` excludes the company-level block (a separate
   *      sub-row on the page surfaces it); this is the natural
   *      "sum of the visible rows" the operator's eye expects to
   *      match the page's totals row.
   */
  async getPerVehicleCost(query: {
    from: Date;
    to: Date;
    vehicleId?: string;
  }): Promise<PerVehicleCostReport> {
    const { from, to, vehicleId } = query;
    const dateRange = buildDateRange(from, to);

    // The per-vehicle WHERE clauses for FuelLog and ExpenseLog.
    // Both share the date range; ExpenseLog additionally narrows
    // by `vehicleId: { not: null }` so the per-vehicle aggregation
    // never picks up the company-level rows. The optional
    // `vehicleId` filter narrows further when present.
    const fuelWhere = {
      date: dateRange,
      ...(vehicleId ? { vehicleId } : {}),
    };
    const expenseWhere = {
      date: dateRange,
      // The `not: null` keeps the per-vehicle aggregation honest:
      // a `groupBy vehicleId` over a nullable column emits a null
      // bucket for the company-level rows, and we don't want to
      // pretend null is a vehicle id. The company-level block is
      // queried separately with its own WHERE below.
      vehicleId: vehicleId ? vehicleId : { not: null },
    } as const;

    // Run all three aggregations in parallel — they are independent
    // and Postgres can stream them concurrently over the same
    // connection-pool slot.
    const [fuelGroups, expenseGroups, companyAggregate] = await Promise.all([
      this.prisma.fuelLog.groupBy({
        by: ["vehicleId"],
        where: fuelWhere,
        _sum: { totalCostPaisa: true },
        _count: { _all: true },
      }),
      this.prisma.expenseLog.groupBy({
        by: ["vehicleId"],
        where: expenseWhere,
        _sum: { amountPaisa: true },
        _count: { _all: true },
      }),
      // Company-level block: ExpenseLog rows with vehicleId IS
      // NULL within the same date range. Always aggregated even
      // when the caller passed a `vehicleId` filter — company
      // expenses don't belong to any vehicle, so the filter
      // doesn't apply (see the docblock above).
      this.prisma.expenseLog.aggregate({
        where: { date: dateRange, vehicleId: null },
        _sum: { amountPaisa: true },
        _count: { _all: true },
      }),
    ]);

    // Build the per-vehicle merge map keyed by vehicleId. Both
    // `fuelGroups` and `expenseGroups` use the same Prisma
    // groupBy shape, so the merge is symmetric.
    interface Accumulator {
      fuelPaisa: number;
      expensePaisa: number;
      fuelLogCount: number;
      expenseLogCount: number;
    }
    const merged = new Map<string, Accumulator>();

    function ensure(vid: string): Accumulator {
      let row = merged.get(vid);
      if (!row) {
        row = { fuelPaisa: 0, expensePaisa: 0, fuelLogCount: 0, expenseLogCount: 0 };
        merged.set(vid, row);
      }
      return row;
    }

    for (const group of fuelGroups) {
      // groupBy returns `vehicleId: string | null` per Prisma's
      // type — FuelLog.vehicleId is required at the schema level,
      // so this is non-null in practice; the guard is for the
      // type-checker.
      if (group.vehicleId === null) continue;
      const row = ensure(group.vehicleId);
      row.fuelPaisa += group._sum.totalCostPaisa ?? 0;
      row.fuelLogCount += group._count._all;
    }
    for (const group of expenseGroups) {
      // The WHERE clause already excluded `vehicleId IS NULL` so
      // this guard is defensive; same shape as the fuel-loop above.
      if (group.vehicleId === null) continue;
      const row = ensure(group.vehicleId);
      row.expensePaisa += group._sum.amountPaisa ?? 0;
      row.expenseLogCount += group._count._all;
    }

    // Look up registration numbers in one batched query. The
    // `findMany` returns at most `merged.size` rows; we route the
    // results into a lookup map keyed by id so the row build below
    // is O(1) per row.
    const vehicleIds = Array.from(merged.keys());
    const vehicles = vehicleIds.length
      ? await this.prisma.vehicle.findMany({
          where: { id: { in: vehicleIds } },
          select: { id: true, registrationNumber: true },
        })
      : [];
    const registrationById = new Map(vehicles.map((v) => [v.id, v.registrationNumber]));

    // Build the response rows. A vehicleId that no longer exists
    // (e.g., a row that was hard-deleted somehow between the
    // groupBy and the findMany — vanishingly rare given Restrict
    // on every parent FK) is dropped; with no registration number
    // to display, including the row would surface "—" in the
    // table without serving any operator need.
    const rows: PerVehicleCostRow[] = [];
    for (const [vid, acc] of merged) {
      const registrationNumber = registrationById.get(vid);
      if (!registrationNumber) continue;
      rows.push({
        vehicleId: vid,
        registrationNumber,
        fuelPaisa: acc.fuelPaisa,
        expensePaisa: acc.expensePaisa,
        totalPaisa: acc.fuelPaisa + acc.expensePaisa,
        fuelLogCount: acc.fuelLogCount,
        expenseLogCount: acc.expenseLogCount,
      });
    }

    // Sort by totalPaisa desc; tie-breaker registrationNumber asc
    // so ties don't shuffle on every refresh. Locale-aware compare
    // for the registration string — Nepal plates are ASCII but the
    // tiebreaker is robust to a future plate scheme that mixes
    // Devanagari digits.
    rows.sort((a, b) => {
      if (b.totalPaisa !== a.totalPaisa) {
        return b.totalPaisa - a.totalPaisa;
      }
      return a.registrationNumber.localeCompare(b.registrationNumber);
    });

    // Totals across the visible rows. Excludes the company-level
    // block by design — the page surfaces the company-level block
    // as a separate sub-row beneath the totals, and the operator
    // expects "sum of the visible rows" to match the totals row
    // bit-for-bit.
    let totalsFuel = 0;
    let totalsExpense = 0;
    for (const row of rows) {
      totalsFuel += row.fuelPaisa;
      totalsExpense += row.expensePaisa;
    }

    return {
      from: formatDateUtc(from),
      to: formatDateUtc(to),
      rows,
      totals: {
        fuelPaisa: totalsFuel,
        expensePaisa: totalsExpense,
        totalPaisa: totalsFuel + totalsExpense,
      },
      companyLevel: {
        expensePaisa: companyAggregate._sum.amountPaisa ?? 0,
        expenseLogCount: companyAggregate._count._all,
      },
    };
  }

  /**
   * Build the per-vehicle fuel-efficiency report for the supplied date
   * range (and optional vehicle filter). See the block comment above
   * EfficiencyFlag for the modeling decisions; the shape mirrors
   * getPerVehicleCost (echoed from / to, per-vehicle rows, fleet totals)
   * minus the companyLevel block (both inputs are always vehicle-bound).
   *
   * Plan:
   *   1. Four `groupBy` aggregations in parallel — completed-trip
   *      distance and fuel consumption, each for the CURRENT window and
   *      the prior-equal-length BASELINE window. Distance sums both
   *      odometer columns (distance = Σend − Σstart); consumption sums
   *      litersMl + totalCostPaisa.
   *   2. Merge the current trip + fuel views into one map keyed by
   *      vehicleId (a vehicle appears if it has EITHER distance or fuel
   *      in the window); merge the baseline views into a second map used
   *      only for the flag comparison.
   *   3. Join to Vehicle for the registration number (one batched
   *      findMany, same as the cost report).
   *   4. Per row: compute the display ratios at the edge and the flag
   *      against the baseline; drop a vehicle that vanished between the
   *      groupBy and the join (no registration to show).
   *   5. Sort (flag, then registration) and roll up fleet totals.
   */
  async getPerVehicleEfficiency(query: {
    from: Date;
    to: Date;
    vehicleId?: string;
  }): Promise<PerVehicleEfficiencyReport> {
    const { from, to, vehicleId } = query;
    const currentRange = buildDateRange(from, to);
    const baselineWindow = priorEqualWindow(from, to);
    const baselineRange = buildDateRange(baselineWindow.from, baselineWindow.to);

    // Trip distance is taken over COMPLETED trips only, attributed to the
    // window by `endedAt` (modeling note 2). A COMPLETED trip is
    // guaranteed to carry both odometer readings, so summing the two
    // columns and subtracting yields Σ(end − start) (note 1).
    const tripWhere = (range: { gte: Date; lte: Date }) => ({
      status: TripStatus.COMPLETED,
      endedAt: range,
      ...(vehicleId ? { vehicleId } : {}),
    });
    // Fuel consumption uses the operator's reporting `date`, exactly as
    // the cost report (note 3). FuelLog.vehicleId is always non-null.
    const fuelWhere = (range: { gte: Date; lte: Date }) => ({
      date: range,
      ...(vehicleId ? { vehicleId } : {}),
    });

    const [currentTrips, currentFuel, baselineTrips, baselineFuel] = await Promise.all([
      this.prisma.trip.groupBy({
        by: ["vehicleId"],
        where: tripWhere(currentRange),
        _sum: { startOdometerKm: true, endOdometerKm: true },
      }),
      this.prisma.fuelLog.groupBy({
        by: ["vehicleId"],
        where: fuelWhere(currentRange),
        _sum: { litersMl: true, totalCostPaisa: true },
      }),
      this.prisma.trip.groupBy({
        by: ["vehicleId"],
        where: tripWhere(baselineRange),
        _sum: { startOdometerKm: true, endOdometerKm: true },
      }),
      this.prisma.fuelLog.groupBy({
        by: ["vehicleId"],
        where: fuelWhere(baselineRange),
        _sum: { litersMl: true, totalCostPaisa: true },
      }),
    ]);

    // Current merge map keyed by vehicleId. Distance and consumption
    // come from different tables; a vehicle with only one of the two
    // still appears (and flags insufficient-data for the missing half).
    interface CurrentAccumulator {
      distanceKm: number;
      litresMl: number;
      fuelPaisa: number;
    }
    const current = new Map<string, CurrentAccumulator>();
    function ensureCurrent(vid: string): CurrentAccumulator {
      let row = current.get(vid);
      if (!row) {
        row = { distanceKm: 0, litresMl: 0, fuelPaisa: 0 };
        current.set(vid, row);
      }
      return row;
    }

    // Prisma types the groupBy key as `string | null` (vehicleId is
    // nullable on PLANNED trips), but the COMPLETED filter guarantees a
    // non-null vehicleId in practice; the guard is for the type-checker.
    for (const group of currentTrips) {
      if (group.vehicleId === null) continue;
      const row = ensureCurrent(group.vehicleId);
      row.distanceKm += (group._sum.endOdometerKm ?? 0) - (group._sum.startOdometerKm ?? 0);
    }
    for (const group of currentFuel) {
      if (group.vehicleId === null) continue;
      const row = ensureCurrent(group.vehicleId);
      row.litresMl += group._sum.litersMl ?? 0;
      row.fuelPaisa += group._sum.totalCostPaisa ?? 0;
    }

    // Baseline map carries only what the flag needs (distance + litres).
    const baseline = new Map<string, EfficiencyBasis>();
    function ensureBaseline(vid: string): EfficiencyBasis {
      let row = baseline.get(vid);
      if (!row) {
        row = { distanceKm: 0, litresMl: 0 };
        baseline.set(vid, row);
      }
      return row;
    }
    for (const group of baselineTrips) {
      if (group.vehicleId === null) continue;
      const row = ensureBaseline(group.vehicleId);
      row.distanceKm += (group._sum.endOdometerKm ?? 0) - (group._sum.startOdometerKm ?? 0);
    }
    for (const group of baselineFuel) {
      if (group.vehicleId === null) continue;
      const row = ensureBaseline(group.vehicleId);
      row.litresMl += group._sum.litersMl ?? 0;
    }

    // Registration join — one batched findMany over the vehicles with
    // current-window activity (the rows we will emit). Same pattern as
    // the cost report; a vehicle that vanished between the groupBy and
    // the join has no registration to show and is dropped below.
    const vehicleIds = Array.from(current.keys());
    const vehicles = vehicleIds.length
      ? await this.prisma.vehicle.findMany({
          where: { id: { in: vehicleIds } },
          select: { id: true, registrationNumber: true },
        })
      : [];
    const registrationById = new Map(vehicles.map((v) => [v.id, v.registrationNumber]));

    const rows: PerVehicleEfficiencyRow[] = [];
    for (const [vid, acc] of current) {
      const registrationNumber = registrationById.get(vid);
      if (!registrationNumber) continue;
      const base = baseline.get(vid) ?? { distanceKm: 0, litresMl: 0 };
      const flag = classifyEfficiency(acc, base);
      // km/L: distance per litre, with litres = mL / 1000 folded into
      // the ×1000. Null exactly when the flag is insufficient-data
      // (which already covers litresMl ≤ 0, so the divide is safe).
      const kmPerLitre =
        flag === "insufficient-data" ? null : (acc.distanceKm * 1000) / acc.litresMl;
      // NPR/km: fuel paisa per km. Null only when there is no distance
      // (no divide-by-zero); independent of the flag, per DESIGN.md.
      const nprPerKm = acc.distanceKm === 0 ? null : acc.fuelPaisa / acc.distanceKm;
      rows.push({
        vehicleId: vid,
        registrationNumber,
        distanceKm: acc.distanceKm,
        litresMl: acc.litresMl,
        kmPerLitre,
        nprPerKm,
        fuelPaisa: acc.fuelPaisa,
        flag,
      });
    }

    // Sort by flag priority (exceptions first), then registration asc.
    rows.sort((a, b) => {
      if (FLAG_SORT_ORDER[a.flag] !== FLAG_SORT_ORDER[b.flag]) {
        return FLAG_SORT_ORDER[a.flag] - FLAG_SORT_ORDER[b.flag];
      }
      return a.registrationNumber.localeCompare(b.registrationNumber);
    });

    // Fleet totals: integers summed, the two ratios computed at the edge.
    let totalDistanceKm = 0;
    let totalLitresMl = 0;
    let totalFuelPaisa = 0;
    for (const row of rows) {
      totalDistanceKm += row.distanceKm;
      totalLitresMl += row.litresMl;
      totalFuelPaisa += row.fuelPaisa;
    }

    return {
      from: formatDateUtc(from),
      to: formatDateUtc(to),
      rows,
      totals: {
        distanceKm: totalDistanceKm,
        litresMl: totalLitresMl,
        fuelPaisa: totalFuelPaisa,
        kmPerLitre: totalLitresMl > 0 ? (totalDistanceKm * 1000) / totalLitresMl : null,
        nprPerKm: totalDistanceKm > 0 ? totalFuelPaisa / totalDistanceKm : null,
      },
    };
  }
}
