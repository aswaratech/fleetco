import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import type { Vehicle } from "../../types";
import { EditVehicleForm } from "./edit-vehicle-form";

// Edit vehicle — iter 3 of the Vehicles slice. Server-rendered shell
// (auth gate, page chrome) wrapping the client-side form. The form is
// pre-filled from the fetched vehicle and submits via a server action
// (../actions.ts:updateVehicleAction) which performs the PATCH. On
// success the action revalidates and redirects to /vehicles.
//
// Layout follows DESIGN.md §"Page header" and §"Inputs and forms":
// max-width centered, breadcrumb above title, vertical form with labels
// above inputs, primary action right-aligned in a footer row.

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditVehiclePage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let vehicle: Vehicle;
  try {
    vehicle = await apiFetch<Vehicle>(`/api/v1/vehicles/${id}`);
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

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href="/vehicles" className="hover:text-text-primary">
              Vehicles
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/vehicles/${vehicle.id}`} className="hover:text-text-primary font-mono">
              {vehicle.registrationNumber}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit vehicle</h1>
          <p className="text-text-muted text-sm">
            Only changed fields are sent to the API. Status changes into Retired or Sold auto-set
            the retirement date; status changes back to Active or In maintenance clear it.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditVehicleForm vehicle={vehicle} />
        </section>
      </div>
    </main>
  );
}
