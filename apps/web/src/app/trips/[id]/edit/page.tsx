import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import type { TripDetail } from "../../types";
import { EditTripForm } from "./edit-trip-form";

// Edit trip — iter 9 of the Trips slice. Server-rendered shell that
// fetches the trip + active Vehicle / Driver lists for the pickers
// (so an operator can reassign a trip to a different vehicle or
// driver), gates auth, then renders the client-side form.
//
// The pickers also include the trip's current Vehicle and Driver
// even if they are not currently ACTIVE — e.g., a trip on a vehicle
// that was retired since the trip was created should remain
// editable, with the retired vehicle still selected. The fetch path
// merges the trip's current ids into the active list (de-duping by
// id) so the form always has the current selection available.
//
// Mirrors apps/web/src/app/drivers/[id]/edit/page.tsx in shape.

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

interface EditPageProps {
  params: Promise<{ id: string }>;
}

async function fetchActiveVehicles(): Promise<ActiveVehicle[]> {
  const query = new URLSearchParams({
    status: "ACTIVE",
    sortBy: "registrationNumber",
    sortDir: "asc",
    take: "200",
  });
  const response = await apiFetch<{ items: ActiveVehicle[] }>(
    `/api/v1/vehicles?${query.toString()}`,
  );
  return response.items;
}

async function fetchActiveDrivers(): Promise<ActiveDriver[]> {
  const query = new URLSearchParams({
    status: "ACTIVE",
    sortBy: "fullName",
    sortDir: "asc",
    take: "200",
  });
  const response = await apiFetch<{ items: ActiveDriver[] }>(`/api/v1/drivers?${query.toString()}`);
  return response.items;
}

export default async function EditTripPage({ params }: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let trip: TripDetail;
  let activeVehicles: ActiveVehicle[];
  let activeDrivers: ActiveDriver[];
  try {
    [trip, activeVehicles, activeDrivers] = await Promise.all([
      apiFetch<TripDetail>(`/api/v1/trips/${id}`),
      fetchActiveVehicles(),
      fetchActiveDrivers(),
    ]);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        redirect("/login");
      }
      if (error.status === 404) {
        notFound();
      }
    }
    throw error;
  }

  // Merge the trip's current Vehicle and Driver into the active lists
  // (de-duping by id) so the form's current selection is always
  // pickable even if the vehicle has been retired / the driver
  // terminated since the trip was created. The sorted-by-name order
  // is preserved; the historical record sits in its alphabetical spot.
  const vehicles = mergeUnique(activeVehicles, {
    id: trip.vehicle.id,
    registrationNumber: trip.vehicle.registrationNumber,
    make: trip.vehicle.make,
    model: trip.vehicle.model,
  });
  const drivers = mergeUnique(activeDrivers, {
    id: trip.driver.id,
    fullName: trip.driver.fullName,
    licenseNumber: trip.driver.licenseNumber,
  });

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
            <Link href={`/trips/${trip.id}`} className="hover:text-text-primary">
              {trip.vehicle.registrationNumber}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit trip</h1>
          <p className="text-text-muted text-sm">
            Only changed fields are sent to the API. Status transitions are validated server-side
            (no jumping from Planned to Completed without going through In progress).
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditTripForm trip={trip} vehicles={vehicles} drivers={drivers} />
        </section>
      </div>
    </main>
  );
}

// Insert `current` at the front of `list` if it isn't already present
// by id. Used to ensure the trip's existing Vehicle / Driver is in
// the picker even if it has since lost its ACTIVE status.
function mergeUnique<T extends { id: string }>(list: T[], current: T): T[] {
  if (list.some((entry) => entry.id === current.id)) return list;
  return [current, ...list];
}
