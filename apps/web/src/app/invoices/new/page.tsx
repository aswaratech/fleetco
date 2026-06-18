import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { CreateInvoiceForm, type CustomerOption, type JobOption } from "./create-invoice-form";

// New invoice — Program D / D6 (write path). Server-rendered shell (auth gate;
// redirect to /login if absent) wrapping the client-side create form. The form
// calls createInvoiceAction (../actions.ts), which POSTs the DRAFT header and
// redirects to /invoices/<id>/edit so the operator continues by adding lines.
//
// The shell pre-fetches the active customers (for the required picker) + all jobs
// (so the optional job picker can filter to the chosen customer client-side, the
// fuel-logs new-form pattern). Mirror of apps/web/src/app/jobs/new/page.tsx.

interface CustomersListResponse {
  items: CustomerOption[];
}

interface JobsListResponse {
  items: JobOption[];
}

export default async function NewInvoicePage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let customers: CustomerOption[] = [];
  let jobs: JobOption[] = [];
  try {
    const [customerList, jobList] = await Promise.all([
      apiFetch<CustomersListResponse>(
        "/api/v1/customers?status=ACTIVE&sortBy=name&sortDir=asc&take=200",
      ),
      apiFetch<JobsListResponse>("/api/v1/jobs?sortBy=jobNumber&sortDir=desc&take=200"),
    ]);
    customers = customerList.items;
    jobs = jobList.items;
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
            <Link href="/invoices" className="hover:text-text-primary">
              Invoices
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New invoice</h1>
          <p className="text-text-muted text-sm">
            Draft an invoice for a customer. You add the billable lines next; the number is assigned
            when you issue it.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          {customers.length === 0 ? (
            <div className="text-text-secondary space-y-3 text-sm">
              <p>No active customers on file.</p>
              <p>
                <Link
                  href="/customers/new"
                  className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                >
                  Register a customer first
                </Link>
                , then come back here to draft an invoice.
              </p>
            </div>
          ) : (
            <CreateInvoiceForm customers={customers} jobs={jobs} />
          )}
        </section>
      </div>
    </main>
  );
}
