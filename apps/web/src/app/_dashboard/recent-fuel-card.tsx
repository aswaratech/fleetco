import { NepaliDate } from "@/components/nepali-date";
import { formatNpr } from "@/lib/money";

import type { FuelLogListItem } from "../fuel-logs/types";
import { DashboardCard } from "./dashboard-card";

// Zone A, card 4 — Recent fuel. DESIGN.md §"Home dashboard" cards 4/5: the last
// five entries — `registration · <NepaliDate> · amount` — linking to the fuel
// log surface. On a FuelLog the vehicle is always present (the FK is required),
// so no null guard is needed here (its sibling expense card differs).

interface RecentFuelCardProps {
  items: FuelLogListItem[];
}

export function RecentFuelCard({ items }: RecentFuelCardProps): React.ReactElement {
  return (
    <DashboardCard title="Recent fuel" link={{ href: "/fuel-logs", label: "All fuel logs" }}>
      {items.length === 0 ? (
        <p className="text-text-secondary">No fuel logs.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((log) => (
            <li key={log.id} className="flex items-center justify-between gap-2">
              <span className="text-text-secondary truncate">
                <span className="text-text-primary font-mono">
                  {log.vehicle.registrationNumber}
                </span>{" "}
                · <NepaliDate iso={log.date} format="bs" />
              </span>
              <span className="text-text-primary tabular-nums">
                {formatNpr(log.totalCostPaisa)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DashboardCard>
  );
}
