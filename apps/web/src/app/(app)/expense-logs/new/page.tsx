import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";

import { CreateExpenseLogForm } from "./create-expense-log-form";

// New expense log — iter 22 of the Expense-logs slice (write path).
// Server-rendered shell (the (app) layout provides the auth gate) wrapping the client-side form. The form itself
// calls the createExpenseLogAction at ../actions.ts which POSTs to
// the API and redirects to /expense-logs/<id> on success.
//
// In addition to auth, the shell fetches the list of active vehicles
// (the picker is OPTIONAL — vehicle-agnostic expenses are a first-
// class shape; the picker has a leading "— no vehicle —" option) and
// the list of recent trips (the picker is also optional — an expense
// may or may not be paired with a trip). Both lists are capped at the
// API's LIST_TAKE_MAX (200); promoting to combobox arrives when the
// cap is approached.
//
// Notable shape difference vs. /fuel-logs/new: there is NO "no active
// vehicles" empty-state. A vehicle is not required to log an expense
// (the CEO can record the quarterly insurance premium with no vehicle
// attribution), so we render the form unconditionally — if the
// vehicle list is empty, the form's picker collapses to just the
// "— no vehicle —" option and the operator can still submit.
//
// Layout mirrors apps/web/src/app/fuel-logs/new/page.tsx and follows
// DESIGN.md §"Page header" and §"Inputs and forms".

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

export default async function NewExpenseLogPage(): Promise<React.ReactElement> {
  // Fetch active vehicles (for the optional picker) and all trips
  // (for the optional trip picker). Sort vehicles by registration
  // ascending so the picker is alphabetical. Trips are sorted by
  // startedAt descending — the operator is most likely pairing an
  // expense with a recent trip.
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
            <Link href="/expense-logs" className="hover:text-text-primary">
              Expense logs
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Log an expense</h1>
          <p className="text-text-muted text-sm">
            Record an expense. Vehicle is optional — leave it as &ldquo;— no vehicle —&rdquo; for
            company-level expenses (e.g. the quarterly insurance premium, office stationery).
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <CreateExpenseLogForm vehicles={vehicles} trips={trips} />
        </section>
      </div>
    </main>
  );
}
