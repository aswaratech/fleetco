import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { EditTrackerForm } from "./edit-tracker-form";
import type { Tracker } from "../../types";

// Edit tracker — ADR-0042 M4 (write path). Server-rendered shell (auth
// gate, 404 handling) that fetches the tracker AND the vehicles picker,
// then hands both to the client form. Mirrors the geofences edit page.
//
// The picker offers ACTIVE / IN_MAINTENANCE vehicles (assignment targets)
// — but when the tracker is currently assigned to a vehicle outside that
// set (e.g. the vehicle was retired after installation), the current
// assignment is prepended so the form renders the truth and the operator
// can unassign it.

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

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditTrackerPage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let tracker: Tracker;
  try {
    tracker = await apiFetch<Tracker>(`/api/v1/telematics/trackers/${id}`);
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
    // Non-401: leave vehicles empty; the form still edits the scalar fields.
  }

  // Keep the current assignment selectable even when its vehicle is outside
  // the ACTIVE/IN_MAINTENANCE picker set.
  if (tracker.vehicle !== null && !vehicles.some((v) => v.id === tracker.vehicle?.id)) {
    vehicles = [tracker.vehicle, ...vehicles];
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
            <Link href={`/trackers/${tracker.id}`} className="hover:text-text-primary font-mono">
              {tracker.imei}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit tracker</h1>
          <p className="text-text-muted text-sm">
            Assign or unassign the vehicle, move the unit through its lifecycle, or correct the
            label / SIM details. Retiring a tracker requires unassigning it first.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditTrackerForm tracker={tracker} vehicles={vehicles} />
        </section>
      </div>
    </main>
  );
}
