import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { CreateGeofenceForm } from "./create-geofence-form";

// New geofence — ADR-0030 G3 (write path). Server-rendered shell (auth gate
// via getServerSession; redirect to /login if absent) wrapping the client-
// side form. The form calls the createGeofenceAction at ../actions.ts which
// posts to the API and redirects to /geofences/<id> on success.
//
// In addition to auth, the shell fetches the customers list so the form can
// render the CUSTOMER_SITE customer picker without a client-side round-trip
// — exactly like the Jobs / Fuel-logs new pages fetch their pickers server-
// side (sortBy=name&sortDir=asc&take=200). Unlike Jobs, an empty customers
// list does NOT block the page: DEPOT and ROUTE_CORRIDOR geofences need no
// customer, so the form still renders; the picker (and its empty-state hint)
// only appear when the operator picks CUSTOMER_SITE.
//
// Layout mirrors apps/web/src/app/jobs/new/page.tsx (max-width centered,
// breadcrumb above title, vertical form with labels above inputs, primary
// action right-aligned in a footer row — DESIGN.md §"Page header" and
// §"Inputs and forms").

// Slim Customer projection sufficient for the picker. Shape matches the list
// endpoint's items; we consume `id` + `name`.
interface CustomerOption {
  id: string;
  name: string;
}

interface CustomersListResponse {
  items: CustomerOption[];
  total: number;
  skip: number;
  take: number;
}

export default async function NewGeofencePage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  // Fetch customers for the CUSTOMER_SITE picker, alphabetical. A 401
  // redirects; any other failure degrades to an empty list (DEPOT /
  // ROUTE_CORRIDOR creation still works; CUSTOMER_SITE shows the empty-state
  // hint) rather than blocking the whole page.
  let customers: CustomerOption[] = [];
  try {
    const response = await apiFetch<CustomersListResponse>(
      "/api/v1/customers?sortBy=name&sortDir=asc&take=200",
    );
    customers = response.items;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    // Non-401: leave customers empty (graceful degradation).
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
            <Link href="/geofences" className="hover:text-text-primary">
              Geofences
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New geofence</h1>
          <p className="text-text-muted text-sm">
            Define a depot, customer-site, or route-corridor boundary. A customer-site geofence
            belongs to a customer; depots and route corridors are company-owned.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <CreateGeofenceForm customers={customers} />
        </section>
      </div>
    </main>
  );
}
