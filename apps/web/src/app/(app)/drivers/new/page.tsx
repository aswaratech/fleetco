import Link from "next/link";
import { redirect } from "next/navigation";

import { getServerSession } from "@/lib/session";

import { CreateDriverForm } from "./create-driver-form";

// New driver — iter 7 of the Drivers slice. Server-rendered shell
// (auth gate, page chrome) wrapping the client-side form. The form
// itself calls a server action (../actions.ts:createDriverAction)
// which posts to the API and redirects to /drivers on success.
//
// Layout mirrors apps/web/src/app/vehicles/new/page.tsx: max-width
// centered, breadcrumb above title, vertical form with labels above
// inputs, primary action right-aligned in a footer row (DESIGN.md
// §"Page header" and §"Inputs and forms").
export default async function NewDriverPage(): Promise<React.ReactElement> {
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
            <Link href="/drivers" className="hover:text-text-primary">
              Drivers
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New driver</h1>
          <p className="text-text-muted text-sm">
            Register a driver in the fleet. License numbers must be unique.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <CreateDriverForm />
        </section>
      </div>
    </main>
  );
}
