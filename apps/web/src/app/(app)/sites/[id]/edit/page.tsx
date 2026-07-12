import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";

import type { Site } from "../../types";
import { EditSiteForm } from "./edit-site-form";

// Edit site — ADR-0047 W5 (write path). Server-rendered shell (auth gate via the
// (app) layout, page chrome) wrapping the client-side form. The form is
// pre-filled from the fetched site and submits via the server action at
// /sites/actions.ts (updateSiteAction), which PATCHes only the diff. On success
// the action revalidates and redirects to /sites/<id> (back to the detail page,
// NOT the list — same as the other aggregates).
//
// Layout mirrors apps/web/src/app/(app)/geofences/[id]/edit/page.tsx.

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditSitePage({ params }: EditPageProps): Promise<React.ReactElement> {
  const { id } = await params;

  let site: Site;
  try {
    site = await apiFetch<Site>(`/api/v1/sites/${id}`);
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
            <Link href="/sites" className="hover:text-text-primary">
              Sites
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/sites/${site.id}`} className="hover:text-text-primary">
              {site.name}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit site</h1>
          <p className="text-text-muted text-sm">Only changed fields are sent to the API.</p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditSiteForm site={site} />
        </section>
      </div>
    </main>
  );
}
