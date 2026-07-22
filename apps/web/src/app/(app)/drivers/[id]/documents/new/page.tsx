import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { UploadDocumentForm } from "@/components/documents/upload-document-form";
import { apiFetch, ApiError } from "@/lib/api";

// Upload a document against one driver (ADR-0049 F4) — the vehicle page's
// thin-shell shape with the driver matrix (license / ID document /
// agreement / other). Driver documents are identity papers: the form's
// helper copy carries the Tier-discipline nudge and the bytes stay behind
// the authed proxy like every document.

interface DriverSlim {
  id: string;
  fullName: string;
}

export default async function NewDriverDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  let driver: DriverSlim;
  try {
    driver = await apiFetch<DriverSlim>(`/api/v1/drivers/${encodeURIComponent(id)}`);
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
            <Link href="/drivers" className="hover:text-text-primary">
              Drivers
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/drivers/${driver.id}`} className="hover:text-text-primary">
              {driver.fullName}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Add document</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Add document</h1>
          <p className="text-text-muted text-sm">
            Attach a license scan, ID document, or agreement for {driver.fullName}.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <UploadDocumentForm
            entityType="DRIVER"
            entityId={driver.id}
            entityPath={`/drivers/${driver.id}`}
          />
        </section>
      </div>
    </main>
  );
}
