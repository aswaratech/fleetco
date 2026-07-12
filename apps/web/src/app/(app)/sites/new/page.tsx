import Link from "next/link";

import { CreateSiteForm } from "./create-site-form";

// New site — ADR-0047 W5 (write path). Server-rendered shell (the (app) layout
// provides the auth gate) wrapping the client-side form. The form calls
// createSiteAction at ../actions.ts which POSTs to the API and redirects to
// /sites/<id> on success.
//
// Unlike the geofences new page there is no picker to pre-fetch — a Site has no
// owning customer — so the shell is just chrome + the form. Layout mirrors
// apps/web/src/app/(app)/geofences/new/page.tsx (max-width centered, breadcrumb
// above title, DESIGN.md §"Page header" and §"Inputs and forms").

export default function NewSitePage(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href="/sites" className="hover:text-text-primary">
              Sites
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New site</h1>
          <p className="text-text-muted text-sm">
            Drop a pin on the map and name it — a reusable pickup or drop-off location for dispatch.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <CreateSiteForm />
        </section>
      </div>
    </main>
  );
}
