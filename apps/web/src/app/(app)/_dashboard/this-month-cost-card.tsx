import { NepaliDate } from "@/components/nepali-date";
import type { DashboardThisMonthCost } from "@/lib/dashboard";
import { formatNpr } from "@/lib/money";

import { DashboardCard } from "./dashboard-card";

// Zone A, card 3 — This-month cost. DESIGN.md §"Home dashboard" card 3: the
// fleet's fuel + expense spend for the current calendar month — the total, a
// muted fuel / expense split, and the month range — with "Cost report →"
// drilling into the full per-vehicle report.
//
// The `totals` here are D1's pass-through of the per-vehicle cost report's
// `totals` block (the sum of the per-vehicle rows; company-level expenses are
// excluded by the report and surface only on the report page itself). Paisa are
// non-negative across this app, so a zero total means no fuel/expense logs this
// month; the money renders via the shipped `formatNpr` (paisa stay integer
// end-to-end, formatted only here).

interface ThisMonthCostCardProps {
  cost: DashboardThisMonthCost;
}

export function ThisMonthCostCard({ cost }: ThisMonthCostCardProps): React.ReactElement {
  const { from, to, totals } = cost;
  const hasActivity = totals.totalPaisa > 0;

  return (
    <DashboardCard
      title="This month"
      link={{ href: "/reports/per-vehicle-cost", label: "Cost report" }}
    >
      <div className="space-y-1">
        <p className="text-text-primary text-2xl font-semibold tabular-nums">
          {formatNpr(totals.totalPaisa)}
        </p>
        {hasActivity ? (
          <p className="text-text-muted tabular-nums">
            Fuel {formatNpr(totals.fuelPaisa)} · Expenses {formatNpr(totals.expensePaisa)}
          </p>
        ) : (
          <p className="text-text-secondary">No fuel or expense logs this month.</p>
        )}
        <p className="text-text-muted text-xs">
          <NepaliDate iso={from} format="bs" /> – <NepaliDate iso={to} format="bs" />
        </p>
      </div>
    </DashboardCard>
  );
}
