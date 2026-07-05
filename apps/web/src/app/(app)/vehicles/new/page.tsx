import Link from "next/link";

import { CreateVehicleForm } from "./create-vehicle-form";

// New vehicle — iter 2 of the Vehicles slice. Server-rendered shell
// (auth gate, page chrome) wrapping the client-side form. The form
// itself calls a server action (`./actions.ts`) which posts to the
// API and redirects to /vehicles on success.
//
// Layout follows DESIGN.md §"Page header" and §"Inputs and forms":
// max-width centered, breadcrumb above title, vertical form with
// labels above inputs, primary action right-aligned in a footer row.
export default async function NewVehiclePage() {
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
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New vehicle</h1>
          <p className="text-text-muted text-sm">
            Register a vehicle in the fleet. Registration numbers must be unique.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <CreateVehicleForm />
        </section>
      </div>
    </main>
  );
}
