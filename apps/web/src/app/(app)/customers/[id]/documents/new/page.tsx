import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { UploadDocumentForm } from "@/components/documents/upload-document-form";
import { apiFetch, ApiError } from "@/lib/api";

// Upload a document against one customer (ADR-0049 F4) — the thin-shell
// shape with the customer matrix (agreement / other): the signed haul
// contracts and rate agreements the PO keeps with each customer.

interface CustomerSlim {
  id: string;
  name: string;
}

export default async function NewCustomerDocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  let customer: CustomerSlim;
  try {
    customer = await apiFetch<CustomerSlim>(`/api/v1/customers/${encodeURIComponent(id)}`);
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
            <Link href="/customers" className="hover:text-text-primary">
              Customers
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/customers/${customer.id}`} className="hover:text-text-primary">
              {customer.name}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Add document</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Add document</h1>
          <p className="text-text-muted text-sm">
            Attach an agreement or contract for {customer.name}. Set the agreement’s expiry to get
            reminder emails before it lapses.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <UploadDocumentForm
            entityType="CUSTOMER"
            entityId={customer.id}
            entityPath={`/customers/${customer.id}`}
          />
        </section>
      </div>
    </main>
  );
}
