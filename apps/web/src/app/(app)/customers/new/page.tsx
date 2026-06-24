import Link from "next/link";
import { redirect } from "next/navigation";

import { getServerSession } from "@/lib/session";

import { CreateCustomerForm } from "./create-customer-form";

// New customer — iter 16 of the Customers slice. Server-rendered shell
// (auth gate, page chrome) wrapping the client-side form. The form
// itself calls a server action (../actions.ts:createCustomerAction)
// which posts to the API and redirects to /customers on success.
//
// Layout mirrors apps/web/src/app/drivers/new/page.tsx: max-width
// centered, breadcrumb above title, vertical form with labels above
// inputs, primary action right-aligned in a footer row (DESIGN.md
// §"Page header" and §"Inputs and forms"). The page chrome carries
// the same "PAN numbers must be unique" sentence so the operator's
// expectation is set before they hit a 409 on submit.
export default async function NewCustomerPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
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
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New customer</h1>
          <p className="text-text-muted text-sm">
            Register a customer in the fleet. PAN numbers must be unique when provided.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <CreateCustomerForm />
        </section>
      </div>
    </main>
  );
}
