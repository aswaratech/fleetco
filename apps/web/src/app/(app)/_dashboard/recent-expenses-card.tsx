import { NepaliDate } from "@/components/nepali-date";
import { formatNpr } from "@/lib/money";

import type { ExpenseLogListItem } from "../expense-logs/types";
import { DashboardCard } from "./dashboard-card";

// Zone A, card 5 — Recent expenses. DESIGN.md §"Home dashboard" cards 4/5: the
// last five entries — `registration · <NepaliDate> · amount` — linking to the
// expense log surface.
//
// The one divergence from Recent fuel: an ExpenseLog's `vehicle` is NULLABLE —
// a vehicle-agnostic expense (e.g. the company's quarterly insurance premium)
// carries `vehicle === null`. We render a "Company" fallback and NEVER touch
// `.registrationNumber` when null (the kickoff's load-bearing null-handling
// requirement).

interface RecentExpensesCardProps {
  items: ExpenseLogListItem[];
}

export function RecentExpensesCard({ items }: RecentExpensesCardProps): React.ReactElement {
  return (
    <DashboardCard
      title="Recent expenses"
      link={{ href: "/expense-logs", label: "All expense logs" }}
    >
      {items.length === 0 ? (
        <p className="text-text-secondary">No expense logs.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((log) => (
            <li key={log.id} className="flex items-center justify-between gap-2">
              <span className="text-text-secondary truncate">
                {log.vehicle ? (
                  <span className="text-text-primary font-mono">
                    {log.vehicle.registrationNumber}
                  </span>
                ) : (
                  <span className="text-text-secondary">Company</span>
                )}{" "}
                · <NepaliDate iso={log.date} format="bs" />
              </span>
              <span className="text-text-primary tabular-nums">{formatNpr(log.amountPaisa)}</span>
            </li>
          ))}
        </ul>
      )}
    </DashboardCard>
  );
}
