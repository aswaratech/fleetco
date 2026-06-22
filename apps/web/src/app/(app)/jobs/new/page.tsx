import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { CreateJobForm } from "./create-job-form";

// New job — iter 18 of the Jobs slice (write path). Server-rendered
// shell (auth gate via getServerSession; redirect to /login if absent)
// wrapping the client-side form. The form itself calls the
// createJobAction at ../actions.ts which posts to the API and redirects
// to /jobs/<id> on success.
//
// In addition to auth, the shell fetches the list of active customers
// so the form can render the customer picker without a client-side
// round-trip. Mirror of how the Trips iter-9 new-trip page fetches
// vehicles + drivers for its pickers. The list is intentionally capped
// at 200 (the API's LIST_TAKE_MAX); a Phase-1 fleet for one Nepal-based
// construction company has on the order of dozens of customers, so a
// search-as-you-type combobox is over-engineering for now — DESIGN.md
// §"Inputs and forms" "Use the simplest control that fits the data".
// A future iter can promote to combobox when the cap is approached.
//
// Layout mirrors apps/web/src/app/customers/new/page.tsx (max-width
// centered, breadcrumb above title, vertical form with labels above
// inputs, primary action right-aligned in a footer row — DESIGN.md
// §"Page header" and §"Inputs and forms").

// Slim Customer projection sufficient for the picker. Shape matches the
// list endpoint's items; we only consume `id` + `name` + `status`.
interface CustomerOption {
  id: string;
  name: string;
  status: string;
}

interface CustomersListResponse {
  items: CustomerOption[];
  total: number;
  skip: number;
  take: number;
}

export default async function NewJobPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  // Fetch active customers for the picker. Sort by name asc so the
  // dropdown is alphabetical (the API's default sort is createdAt desc
  // which is wrong for a picker). If the customers fetch itself 401s
  // we redirect to login (same defensive branch the detail pages use);
  // any other failure bubbles to the framework error boundary.
  let customers: CustomerOption[] = [];
  try {
    const response = await apiFetch<CustomersListResponse>(
      "/api/v1/customers?status=ACTIVE&sortBy=name&sortDir=asc&take=200",
    );
    customers = response.items;
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
            <Link href="/jobs" className="hover:text-text-primary">
              Jobs
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New job</h1>
          <p className="text-text-muted text-sm">
            Book a job for an active customer. The job number is generated when the job is saved.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          {customers.length === 0 ? (
            // Defensive empty-state — without at least one active
            // customer the create form has nothing to submit. The
            // operator's path forward is to register a customer first.
            <div className="text-text-secondary space-y-3 text-sm">
              <p>No active customers on file.</p>
              <p>
                <Link
                  href="/customers/new"
                  className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                >
                  Register a customer first
                </Link>
                , then come back here to book a job.
              </p>
            </div>
          ) : (
            <CreateJobForm customers={customers} />
          )}
        </section>
      </div>
    </main>
  );
}
