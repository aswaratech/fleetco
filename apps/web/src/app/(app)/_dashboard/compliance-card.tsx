import { Badge } from "@/components/ui/badge";
import type { ComplianceRollUp } from "@/lib/dashboard";

import { DashboardCard } from "./dashboard-card";

// Zone A, card 1 — Fleet compliance (the headline, spans the grid full-width).
// DESIGN.md §"Home dashboard" card 1: the day's most actionable signal — how
// many vehicles carry a lapsing or lapsed compliance document, by the
// worst-of-three roll-up D1 computed server-side (`rollUpCompliance`). Voice
// register: a stated fact, never a celebration and never a false alarm — a
// chip appears only when its count is non-zero (no "0 expired" red chip), and
// all-clear is the success chip, not an exclamation.

interface ComplianceCardProps {
  compliance: ComplianceRollUp;
}

export function ComplianceCard({ compliance }: ComplianceCardProps): React.ReactElement {
  const { expiredCount, expiringSoonCount, total } = compliance;

  // Empty fleet: nothing to roll up. Point at the create flow, not the list.
  if (total === 0) {
    return (
      <DashboardCard
        title="Fleet compliance"
        className="lg:col-span-3"
        link={{ href: "/vehicles/new", label: "Register a vehicle" }}
      >
        <p className="text-text-secondary">No vehicles registered.</p>
      </DashboardCard>
    );
  }

  // Each vehicle is counted at most once by its worst document state
  // (rollUpCompliance), so the two buckets never overlap and their sum is the
  // number of vehicles needing attention.
  const attentionCount = expiredCount + expiringSoonCount;

  return (
    <DashboardCard
      title="Fleet compliance"
      className="lg:col-span-3"
      link={{ href: "/vehicles", label: "Review vehicles" }}
    >
      {attentionCount === 0 ? (
        <Badge variant="success">All documents current</Badge>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-text-primary text-2xl font-semibold tabular-nums">
            {attentionCount}
          </span>
          <span className="text-text-secondary">
            {attentionCount === 1 ? "vehicle needs attention" : "vehicles need attention"}
          </span>
          {expiredCount > 0 ? <Badge variant="error">{expiredCount} expired</Badge> : null}
          {expiringSoonCount > 0 ? (
            <Badge variant="warning">{expiringSoonCount} expiring soon</Badge>
          ) : null}
          <span className="text-text-muted">
            across {total} {total === 1 ? "vehicle" : "vehicles"}
          </span>
        </div>
      )}
    </DashboardCard>
  );
}
