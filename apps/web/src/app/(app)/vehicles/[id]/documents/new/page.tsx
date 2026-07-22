import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { UploadDocumentForm } from "@/components/documents/upload-document-form";
import { apiFetch, ApiError } from "@/lib/api";

// Upload a document against one vehicle (ADR-0049 F4, DESIGN.md §"Fleet
// documents & renewals") — a thin server shell hosting the shared upload
// form: fetch the vehicle for the breadcrumb (404 on a ghost id), then the
// form posts multipart through the server action and returns to the detail
// page's Documents section.

interface VehicleSlim {
  id: string;
  registrationNumber: string;
}

export default async function NewVehicleDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  let vehicle: VehicleSlim;
  try {
    vehicle = await apiFetch<VehicleSlim>(`/api/v1/vehicles/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login");
    if (error instanceof ApiError && error.status === 404) notFound();
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
            <span className="text-text-secondary">Add document</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Add document</h1>
          <p className="text-text-muted text-sm">
            Attach a Bluebook scan, insurance policy, permit papers, or an agreement to{" "}
            <span className="font-mono">{vehicle.registrationNumber}</span>.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <UploadDocumentForm
            entityType="VEHICLE"
            entityId={vehicle.id}
            entityPath={`/vehicles/${vehicle.id}`}
          />
        </section>
      </div>
    </main>
  );
}
