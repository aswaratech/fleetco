import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import type { Geofence } from "../../types";
import { EditGeofenceForm } from "./edit-geofence-form";

// Edit geofence — ADR-0030 G3 (write path). Server-rendered shell (auth gate,
// page chrome) wrapping the client-side form. The form is pre-filled from the
// fetched geofence and submits via the server action at /geofences/actions.ts
// (updateGeofenceAction), which PATCHes the diff. On success the action
// revalidates and redirects to /geofences/<id> (back to the detail page, NOT
// the list — same as the other aggregates).
//
// Layout mirrors apps/web/src/app/jobs/[id]/edit/page.tsx and follows
// DESIGN.md §"Page header" and §"Inputs and forms". All four fields are
// mutable (name, type, boundary, customerId); the customer picker is shown
// only for CUSTOMER_SITE, the same as the create form.

interface EditPageProps {
  params: Promise<{ id: string }>;
}

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

export default async function EditGeofencePage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let geofence: Geofence;
  try {
    geofence = await apiFetch<Geofence>(`/api/v1/geofences/${id}`);
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

  // Customers for the CUSTOMER_SITE picker, alphabetical. A 401 redirects;
  // any other failure degrades to an empty list (the form still edits name /
  // type / boundary).
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

  // Ensure the current owner is selectable even if it falls outside the first
  // 200 customers — fetch + prepend it when missing so the picker pre-selects
  // the stored owner rather than showing the placeholder.
  if (geofence.customerId && !customers.some((c) => c.id === geofence.customerId)) {
    try {
      const owner = await apiFetch<CustomerOption>(`/api/v1/customers/${geofence.customerId}`);
      customers = [{ id: owner.id, name: owner.name }, ...customers];
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirect("/login");
      }
      // Non-401: leave as-is; the picker falls back to the placeholder.
    }
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
            <Link href={`/geofences/${geofence.id}`} className="hover:text-text-primary">
              {geofence.name}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit geofence</h1>
          <p className="text-text-muted text-sm">
            Only changed fields are sent to the API. Switching the type away from customer-site
            clears the owning customer.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditGeofenceForm geofence={geofence} customers={customers} />
        </section>
      </div>
    </main>
  );
}
