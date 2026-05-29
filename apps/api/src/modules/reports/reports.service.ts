import { Injectable } from "@nestjs/common";

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
}
