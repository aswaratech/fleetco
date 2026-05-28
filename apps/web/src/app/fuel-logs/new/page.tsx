import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { CreateFuelLogForm } from "./create-fuel-log-form";

// New fuel log — iter 20 of the Fuel-logs slice (write path). Server-
// rendered shell (auth gate via getServerSession; redirect to /login
// if absent) wrapping the client-side form. The form itself calls the
// createFuelLogAction at ../actions.ts which POSTs to the API and
// redirects to /fuel-logs/<id> on success.
//
// In addition to auth, the shell fetches the list of active vehicles
// (the picker is required — vehicleId is mandatory on POST) and the
// list of recent trips (the picker is optional — a fill may or may
// not be paired with a trip). The trip picker is rendered as an
// alphabetised list of all trips, with the vehicle registration
// shown so the operator can pick the right one without leaving the
// page. Both lists are capped at the API's LIST_TAKE_MAX (200);
// promoting to combobox arrives when the cap is approached.
//
// Layout mirrors apps/web/src/app/jobs/new/page.tsx and
// apps/web/src/app/customers/new/page.tsx (max-width centered,
// breadcrumb above title, vertical form, primary action right-aligned
// in a footer row — DESIGN.md §"Page header" and §"Inputs and forms").

interface VehicleOption {
  id: string;
  registrationNumber: string;
  status: string;
}

interface VehiclesListResponse {
  items: VehicleOption[];
  total: number;
  skip: number;
  take: number;
}

interface TripOption {
  id: string;
  vehicleId: string;
  status: string;
  vehicle: { id: string; registrationNumber: string };
}

interface TripsListResponse {
  items: TripOption[];
  total: number;
  skip: number;
  take: number;
}

export default async function NewFuelLogPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  // Fetch active vehicles (for the required picker) and all trips
  // (for the optional trip picker). Sort vehicles by registration
  // ascending so the picker is alphabetical. Trips are sorted by
  // startedAt descending — the operator is most likely pairing a
  // fill with a recent trip.
  let vehicles: VehicleOption[] = [];
  let trips: TripOption[] = [];
  try {
    const [vehiclesResponse, tripsResponse] = await Promise.all([
      apiFetch<VehiclesListResponse>(
        "/api/v1/vehicles?status=ACTIVE&sortBy=registrationNumber&sortDir=asc&take=200",
      ),
      apiFetch<TripsListResponse>("/api/v1/trips?sortBy=startedAt&sortDir=desc&take=200"),
    ]);
    vehicles = vehiclesResponse.items;
    trips = tripsResponse.items;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
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
            <Link href="/fuel-logs" className="hover:text-text-primary">
              Fuel logs
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Log a fill</h1>
          <p className="text-text-muted text-sm">
            Record a fuel fill for an active vehicle. Total cost is computed from liters and price
            per liter — you do not enter it.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          {vehicles.length === 0 ? (
            // Defensive empty-state — without at least one active
            // vehicle the create form has nothing to submit. The
            // operator's path forward is to register a vehicle first.
            <div className="text-text-secondary space-y-3 text-sm">
              <p>No active vehicles on file.</p>
              <p>
                <Link
                  href="/vehicles/new"
                  className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                >
                  Register a vehicle first
                </Link>
                , then come back here to log a fill.
              </p>
            </div>
          ) : (
            <CreateFuelLogForm vehicles={vehicles} trips={trips} />
          )}
        </section>
      </div>
    </main>
  );
}
