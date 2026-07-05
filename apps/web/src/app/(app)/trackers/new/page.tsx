import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";

import { CreateTrackerForm } from "./create-tracker-form";

// New tracker — ADR-0042 M4 (write path). Server-rendered shell (the (app) layout provides the auth gate) wrapping the client-
// side form. The form calls createTrackerAction at ../actions.ts which
// posts to the API and redirects to /trackers/<id> on success.
//
// In addition to auth, the shell fetches the vehicles list so the form can
// render the assignment picker without a client-side round-trip — exactly
// like the geofences new page fetches its customer picker. Only ACTIVE and
// IN_MAINTENANCE vehicles are offered (a tracker is mounted on an asset in
// service; RETIRED / SOLD vehicles have left the fleet). An empty vehicles
// list does NOT block the page: a tracker registers fine as an unassigned
// spare.

// Slim Vehicle projection sufficient for the picker.
interface VehicleOption {
  id: string;
  registrationNumber: string;
}

interface VehiclesListResponse {
  items: VehicleOption[];
  total: number;
  skip: number;
  take: number;
}

export default async function NewTrackerPage(): Promise<React.ReactElement> {
  // Fetch vehicles for the assignment picker, by registration. A 401
  // redirects; any other failure degrades to an empty list (spare
  // registration still works) rather than blocking the whole page.
  let vehicles: VehicleOption[] = [];
  try {
    const response = await apiFetch<VehiclesListResponse>(
      "/api/v1/vehicles?status=ACTIVE,IN_MAINTENANCE&sortBy=registrationNumber&sortDir=asc&take=200",
    );
    vehicles = response.items;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    // Non-401: leave vehicles empty (graceful degradation).
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href="/trackers" className="hover:text-text-primary">
              Trackers
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New tracker</h1>
          <p className="text-text-muted text-sm">
            Register a GPS tracker unit by its IMEI. Assign it to a vehicle now, or register it as a
            spare and assign it when it is installed. The same IMEI must also be registered in the
            Traccar gateway before the unit's positions flow in.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <CreateTrackerForm vehicles={vehicles} />
        </section>
      </div>
    </main>
  );
}
