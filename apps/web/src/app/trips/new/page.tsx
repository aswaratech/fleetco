import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { CreateTripForm } from "./create-trip-form";

// New trip — iter 9 of the Trips slice. Server-rendered shell that
// fetches the active Vehicle + Driver lists (for the form's pickers)
// and gates auth, then renders the client-side form. The form posts
// via `createTripAction` (../actions.ts) and redirects to the new
// trip's detail page on success.
//
// Picker scope: only ACTIVE Vehicles and ACTIVE Drivers (the iter-7
// Driver write path established `status=ACTIVE` as the meaningful
// "available for assignment" filter; Vehicles uses the same convention
// for its status enum). Retired vehicles and terminated drivers are
// excluded from the picker — assigning them would be a data-integrity
// foot-gun. The picker takes up to 200 of each so a Phase-1-sized
// fleet (~tens of records) renders without pagination.
//
// Mirrors apps/web/src/app/drivers/new/page.tsx in shape (max-width
// centered, breadcrumb above title, vertical form, primary action
// right-aligned).

interface ActiveVehicle {
  id: string;
  registrationNumber: string;
  make: string;
  model: string;
}

interface ActiveDriver {
  id: string;
  fullName: string;
  licenseNumber: string;
}

interface VehiclesListResponse {
  items: ActiveVehicle[];
}

interface DriversListResponse {
  items: ActiveDriver[];
}

async function fetchActiveVehicles(): Promise<ActiveVehicle[]> {
  // Sort by registration so the picker is alphabetically scannable.
  const query = new URLSearchParams({
    status: "ACTIVE",
    sortBy: "registrationNumber",
    sortDir: "asc",
    take: "200",
  });
  const response = await apiFetch<VehiclesListResponse>(`/api/v1/vehicles?${query.toString()}`);
  return response.items;
}

async function fetchActiveDrivers(): Promise<ActiveDriver[]> {
  const query = new URLSearchParams({
    status: "ACTIVE",
    sortBy: "fullName",
    sortDir: "asc",
    take: "200",
  });
  const response = await apiFetch<DriversListResponse>(`/api/v1/drivers?${query.toString()}`);
  return response.items;
}

export default async function NewTripPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let vehicles: ActiveVehicle[];
  let drivers: ActiveDriver[];
  try {
    [vehicles, drivers] = await Promise.all([fetchActiveVehicles(), fetchActiveDrivers()]);
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
            <Link href="/trips" className="hover:text-text-primary">
              Trips
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New trip</h1>
          <p className="text-text-muted text-sm">
            Plan or record a trip. Active vehicles and active drivers only — retired or terminated
            records are not pickable.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          {vehicles.length === 0 || drivers.length === 0 ? (
            <div className="text-text-secondary space-y-3 text-sm">
              {vehicles.length === 0 ? (
                <p>
                  No active vehicles registered.{" "}
                  <Link
                    href="/vehicles/new"
                    className="text-text-primary underline underline-offset-4"
                  >
                    Register a vehicle first.
                  </Link>
                </p>
              ) : null}
              {drivers.length === 0 ? (
                <p>
                  No active drivers registered.{" "}
                  <Link
                    href="/drivers/new"
                    className="text-text-primary underline underline-offset-4"
                  >
                    Register a driver first.
                  </Link>
                </p>
              ) : null}
            </div>
          ) : (
            <CreateTripForm vehicles={vehicles} drivers={drivers} />
          )}
        </section>
      </div>
    </main>
  );
}
