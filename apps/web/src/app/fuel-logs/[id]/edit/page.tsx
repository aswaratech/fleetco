import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import type { FuelLogDetail } from "../../types";
import { EditFuelLogForm } from "./edit-fuel-log-form";

// Edit fuel log — iter 20 of the Fuel-logs slice (write path). Server-
// rendered shell (auth gate, page chrome) wrapping the client-side
// form. The form is pre-filled from the fetched fuel log and submits
// via the server action at /fuel-logs/actions.ts (updateFuelLogAction),
// which performs the PATCH. On success the action revalidates and
// redirects to /fuel-logs/<id> (back to the detail page).
//
// Layout mirrors apps/web/src/app/jobs/[id]/edit/page.tsx and follows
// DESIGN.md §"Page header" and §"Inputs and forms".
//
// `vehicleId` is immutable per the API's schema (the PATCH endpoint's
// .strict() rejects it). The edit form renders the vehicle registration
// as a read-only display row so the operator sees what it is without
// being able to change it. `tripId` is mutable.
//
// To populate the (optional) trip picker, the shell also fetches the
// list of recent trips for this vehicle so the form can let the
// operator re-pair or unpair the fill. Filtering happens client-side
// against the same vehicleId — the API's read filter already supports
// `?vehicleId=` but we fetch the full recent list once and filter in
// the form so the pick is always responsive.

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

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditFuelLogPage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let fuelLog: FuelLogDetail;
  try {
    fuelLog = await apiFetch<FuelLogDetail>(`/api/v1/fuel-logs/${id}`);
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

  // Fetch trips for this vehicle so the trip picker is scoped. Sorted
  // by startedAt desc; same cap as the create shell.
  let trips: TripOption[] = [];
  try {
    const response = await apiFetch<TripsListResponse>(
      `/api/v1/trips?vehicleId=${fuelLog.vehicleId}&sortBy=startedAt&sortDir=desc&take=200`,
    );
    trips = response.items;
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
            <Link
              href={`/fuel-logs/${fuelLog.id}`}
              className="hover:text-text-primary tabular-nums"
            >
              {fuelLog.date.slice(0, 10)}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit fuel log</h1>
          <p className="text-text-muted text-sm">
            The vehicle is fixed. Only changed fields are sent to the API. Total cost is recomputed
            when liters or price per liter is touched.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditFuelLogForm fuelLog={fuelLog} trips={trips} />
        </section>
      </div>
    </main>
  );
}
