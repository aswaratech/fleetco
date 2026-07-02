import { redirect } from "next/navigation";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { LiveMapLoader } from "./live-map-loader";
import type { DepotFence, LatestPosition, LatestPositionsResponse } from "./types";

// Live map — ADR-0042 M9, built exactly to DESIGN.md §Surfaces "Live map":
// the at-a-glance "where is the fleet right now" surface. One latest fix
// per vehicle, never trails (raw trails are Tier 5, ADMIN-only, a future
// dedicated surface — ADR-0027 c6/c7).
//
// Server component: gates the session, fetches the INITIAL data via
// apiFetch (cookie-forwarding, server-only), and hands everything to the
// client island, which owns the 20 s visibility-paused poll from the
// browser (the browser sends the session cookie itself; apiFetch cannot run
// client-side). The data endpoint is `gps:read-derived` (ADMIN +
// OFFICE_STAFF) — the API enforces it; the page does no extra role-gating,
// like every other surface.
//
// Fetched once per page load (not re-polled): the DEPOT yard fences and
// the tracker register (to split fix-less vehicles into "No tracker" vs
// "No fix yet" in the sidebar — absence-of-data is data, and the two
// absences have different fixes: install hardware vs wait/troubleshoot).

interface GeofenceRow {
  id: string;
  name: string;
  boundaryWkt: string;
}

interface GeofencesListResponse {
  items: GeofenceRow[];
  total: number;
}

interface TrackerRow {
  vehicleId: string | null;
  status: "ACTIVE" | "SPARE" | "RETIRED";
}

interface TrackersListResponse {
  items: TrackerRow[];
  total: number;
}

export default async function MapPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let positions: LatestPosition[];
  let depots: DepotFence[];
  let trackedVehicleIds: string[];
  let trackersRegistered: number;
  try {
    const [latest, fences, trackers] = await Promise.all([
      apiFetch<LatestPositionsResponse>("/api/v1/telematics/positions/latest"),
      // The yard overlay: DEPOT fences only (CUSTOMER_SITE / ROUTE_CORRIDOR
      // are deliberately not drawn in v1 — visual noise before value).
      apiFetch<GeofencesListResponse>("/api/v1/geofences?type=DEPOT&take=200"),
      apiFetch<TrackersListResponse>("/api/v1/telematics/trackers?take=200"),
    ]);
    positions = latest.positions;
    depots = fences.items.map((f) => ({ id: f.id, name: f.name, boundaryWkt: f.boundaryWkt }));
    trackedVehicleIds = trackers.items
      .filter((t) => t.status === "ACTIVE" && t.vehicleId !== null)
      .map((t) => t.vehicleId as string);
    trackersRegistered = trackers.total;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Live map" }]} />
          <h1 className="text-text-primary text-2xl font-semibold">Live map</h1>
          <p className="text-text-muted text-sm">
            Every tracked vehicle&rsquo;s latest fix. Marker hue is fix age — a quiet tracker shows
            where the vehicle <em>was</em>, and says so.
          </p>
        </header>

        <LiveMapLoader
          initialPositions={positions}
          depots={depots}
          trackedVehicleIds={trackedVehicleIds}
          trackersRegistered={trackersRegistered}
        />
      </div>
    </main>
  );
}
