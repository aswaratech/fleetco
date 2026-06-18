import { Badge } from "@/components/ui/badge";
import type { ServiceScheduleRollUp } from "@/lib/dashboard";

import { DashboardCard } from "./dashboard-card";

// Zone A, card 7 — Services due (ADR-0037 B5; DESIGN.md §"Preventive
// maintenance"). The maintenance sibling of the Fleet-compliance headline: how
// many ACTIVE service schedules are currently due-soon or overdue across the
// fleet, by the server-side `rollUpServiceSchedules` roll-up (D1's
// `loadDashboard`). Voice register: a stated fact — a chip appears only when its
// count is non-zero (no "0 overdue" red chip), and all-clear is the success
// chip, not an exclamation. Anti-pattern #3: one contextual link to the
// due-list. The unit is the SCHEDULE (a vehicle may have several), unlike the
// compliance card's per-vehicle count.

interface ServicesDueCardProps {
  services: ServiceScheduleRollUp;
}

export function ServicesDueCard({ services }: ServicesDueCardProps): React.ReactElement {
  const { overdueCount, dueSoonCount, total } = services;

  // No schedules at all: point at the create flow, not the due-list.
  if (total === 0) {
    return (
      <DashboardCard
        title="Services due"
        link={{ href: "/service-schedules/new", label: "Define a schedule" }}
      >
        <p className="text-text-secondary">No service schedules defined.</p>
      </DashboardCard>
    );
  }

  // overdue and due-soon are mutually exclusive per schedule, so their sum is the
  // number of schedules needing attention.
  const attentionCount = overdueCount + dueSoonCount;

  return (
    <DashboardCard
      title="Services due"
      link={{ href: "/service-schedules/due", label: "Services due" }}
    >
      {attentionCount === 0 ? (
        <Badge variant="success">All services on track</Badge>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-text-primary text-2xl font-semibold tabular-nums">
            {attentionCount}
          </span>
          <span className="text-text-secondary">
            {attentionCount === 1 ? "service due" : "services due"}
          </span>
          {overdueCount > 0 ? <Badge variant="error">{overdueCount} overdue</Badge> : null}
          {dueSoonCount > 0 ? <Badge variant="warning">{dueSoonCount} due soon</Badge> : null}
          <span className="text-text-muted">
            across {total} {total === 1 ? "schedule" : "schedules"}
          </span>
        </div>
      )}
    </DashboardCard>
  );
}
