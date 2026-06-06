import type { DashboardCounts } from "@/lib/dashboard";

import { DashboardCard } from "./dashboard-card";

// Zone A, card 6 — Fleet counts. DESIGN.md §"Home dashboard" card 6: three
// tabular stats — vehicles, drivers, active trips. Pure summary, no contextual
// link (its three subjects each have their own quick link in Zone B). The
// vehicle and active-trip counts reuse the `total` D1 already read for the
// compliance and active-trips cards; only the driver count needed its own read.

interface FleetCountsCardProps {
  counts: DashboardCounts;
}

export function FleetCountsCard({ counts }: FleetCountsCardProps): React.ReactElement {
  const stats = [
    { label: "Vehicles", value: counts.vehicles },
    { label: "Drivers", value: counts.drivers },
    { label: "Active trips", value: counts.activeTrips },
  ];

  return (
    <DashboardCard title="Fleet counts">
      <dl className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="space-y-0.5">
            <dt className="text-text-muted text-xs">{stat.label}</dt>
            <dd className="text-text-primary text-2xl font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </DashboardCard>
  );
}
