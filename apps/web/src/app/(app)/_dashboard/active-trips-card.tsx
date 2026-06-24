import { Badge } from "@/components/ui/badge";
import type { DashboardActiveTrips } from "@/lib/dashboard";

import { DashboardCard } from "./dashboard-card";

// Zone A, card 2 — Active trips. DESIGN.md §"Home dashboard" card 2: trips in
// progress now — a count plus a short list (≤ 5, capped by D1's `take=5`) of
// `registration · driver`, each carrying the in-progress status badge. Empty
// state states the fact, no apology.

interface ActiveTripsCardProps {
  activeTrips: DashboardActiveTrips;
}

export function ActiveTripsCard({ activeTrips }: ActiveTripsCardProps): React.ReactElement {
  const { items, total } = activeTrips;

  return (
    <DashboardCard title="Active trips" link={{ href: "/trips", label: "All trips" }}>
      {total === 0 ? (
        <p className="text-text-secondary">No trips in progress.</p>
      ) : (
        <div className="space-y-2">
          <p>
            <span className="text-text-primary text-2xl font-semibold tabular-nums">{total}</span>
            <span className="text-text-secondary">
              {" "}
              {total === 1 ? "trip in progress" : "trips in progress"}
            </span>
          </p>
          <ul className="space-y-1">
            {items.map((trip) => (
              <li key={trip.id} className="flex items-center justify-between gap-2">
                <span className="text-text-secondary truncate">
                  <span className="text-text-primary font-mono">
                    {trip.vehicle.registrationNumber}
                  </span>{" "}
                  · {trip.driver.fullName}
                </span>
                <Badge variant="success">In progress</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DashboardCard>
  );
}
