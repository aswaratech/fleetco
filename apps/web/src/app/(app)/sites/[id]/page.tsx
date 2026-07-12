import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DetailRow } from "@/components/ui/detail-row";
import { apiFetch, ApiError } from "@/lib/api";
import { formatCoord, SITE_KIND_LABELS } from "@/lib/sites-schema";

import { DeleteSiteDialog } from "./delete-site-dialog";
import { SiteDetailMap } from "./site-map-view";
import type { Site } from "../types";

// Site detail — ADR-0047 W5 (read path). Server-rendered shell (the (app) layout
// provides the auth gate); fetches the site via apiFetch and surfaces 404
// through Next.js's notFound() route. Mirrors the geofences detail page in
// shape.
//
// DESIGN.md §Sites: name, kind, coordinates, address, contact name/phone, a
// READ-ONLY single-marker map centered on the pin, and the audit timestamps.
// The contact phone renders as a `tel:` tap-to-call affordance (never printed
// into a copyable filter URL — anti-pattern #15). The future `Site.geofenceId`
// owning-fence row is deferred (ADR-0047 c4), so it is absent here.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

// Site has no date-only fields, so the audit timestamps render via a local
// formatTimestamp (UTC, seconds precision) rather than <NepaliDate> — matching
// the geofences detail page.
function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function SiteDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
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

  const kindLabel = SITE_KIND_LABELS[site.kind] ?? site.kind;

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb
              items={[
                { label: "FleetCo", href: "/" },
                { label: "Sites", href: "/sites" },
                { label: site.name },
              ]}
            />
            <h1 className="text-text-primary text-2xl font-semibold">{site.name}</h1>
            <p className="text-text-muted text-sm">{kindLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/sites/${site.id}/edit`}>Edit</Link>
            </Button>
            <DeleteSiteDialog id={site.id} name={site.name} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Details
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Name" value={site.name} />
            <DetailRow label="Kind" value={<Badge variant="neutral">{kindLabel}</Badge>} />
            <DetailRow
              label="Coordinates"
              numeric
              value={`${formatCoord(site.latitude)}, ${formatCoord(site.longitude)}`}
            />
            <DetailRow label="Address" value={site.address ?? "—"} />
            <DetailRow label="Contact name" value={site.contactName ?? "—"} />
            <DetailRow
              label="Contact phone"
              value={
                site.contactPhone ? (
                  <a
                    href={`tel:${site.contactPhone}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    {site.contactPhone}
                  </a>
                ) : (
                  "—"
                )
              }
            />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Location
          </h2>
          <SiteDetailMap latitude={site.latitude} longitude={site.longitude} name={site.name} />
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(site.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(site.updatedAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}
