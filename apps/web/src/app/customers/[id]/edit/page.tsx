import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import type { Customer } from "../../types";
import { EditCustomerForm } from "./edit-customer-form";

// Edit customer — iter 16 of the Customers slice. Server-rendered
// shell (auth gate, page chrome) wrapping the client-side form. The
// form is pre-filled from the fetched customer and submits via the
// server action at /customers/actions.ts (updateCustomerAction),
// which performs the PATCH. On success the action revalidates and
// redirects to /customers/<id> (back to the detail page, NOT the
// list — same as Drivers iter 7).
//
// Layout mirrors apps/web/src/app/drivers/[id]/edit/page.tsx and
// follows DESIGN.md §"Page header" and §"Inputs and forms".

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditCustomerPage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let customer: Customer;
  try {
    customer = await apiFetch<Customer>(`/api/v1/customers/${id}`);
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
            <Link href="/customers" className="hover:text-text-primary">
              Customers
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/customers/${customer.id}`} className="hover:text-text-primary">
              {customer.name}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit customer</h1>
          <p className="text-text-muted text-sm">
            Only changed fields are sent to the API. Clear an optional field by emptying its input;
            the change saves as no value on file.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditCustomerForm customer={customer} />
        </section>
      </div>
    </main>
  );
}
