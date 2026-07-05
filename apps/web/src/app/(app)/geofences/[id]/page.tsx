import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DetailRow } from "@/components/ui/detail-row";
import { apiFetch, ApiError } from "@/lib/api";
import { GEOFENCE_TYPE_LABELS, wktToVertexInput } from "@/lib/geofences-schema";

import { DeleteGeofenceDialog } from "./delete-geofence-dialog";
import type { Geofence } from "../types";

// Geofence detail — ADR-0030 G3 (read path). Server-rendered shell (the (app) layout provides the auth gate); fetches the
// geofence via apiFetch and surfaces 404 through Next.js's notFound() route.
// Mirrors apps/web/src/app/jobs/[id]/page.tsx and the customers detail page
// in shape.
//
// The owning Customer (for CUSTOMER_SITE fences) is NOT nested in the
// geofence response, so it is resolved by a second fetch and deep-linked to
// /customers/<id> — the same cross-slice pivot the Jobs detail page uses.
// DEPOT / ROUTE_CORRIDOR fences are company-owned (customerId null) and show
// an em-dash.
//
// The boundary is rendered as a read-only human-readable vertex list (the
// stored `boundaryWkt` decoded to `lon, lat` points via wktToVertexInput),
// with the raw WKT shown muted beneath. The Leaflet map render is G4.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

// Slim Customer projection sufficient for the name + deep-link.
interface CustomerSummary {
  id: string;
  name: string;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function GeofenceDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const { id } = await params;

  let geofence: Geofence;
  try {
    geofence = await apiFetch<Geofence>(`/api/v1/geofences/${id}`);
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

  // Resolve the owning customer's name for the deep-link (CUSTOMER_SITE
  // only). A 401 redirects; any other failure leaves `customer` null and the
  // row still deep-links using the raw id as its label (the FK Restrict makes
  // a missing customer effectively impossible, so this is defensive).
  let customer: CustomerSummary | null = null;
  if (geofence.customerId !== null) {
    try {
      customer = await apiFetch<CustomerSummary>(`/api/v1/customers/${geofence.customerId}`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirect("/login");
      }
      // Non-401: fall back to the raw id below.
    }
  }

  const typeLabel = GEOFENCE_TYPE_LABELS[geofence.type] ?? geofence.type;
  const vertexInput = wktToVertexInput(geofence.boundaryWkt);
  const vertices = vertexInput.length > 0 ? vertexInput.split(";") : [];

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb
              items={[
                { label: "FleetCo", href: "/" },
                { label: "Geofences", href: "/geofences" },
                { label: geofence.name },
              ]}
            />
            <h1 className="text-text-primary text-2xl font-semibold">{geofence.name}</h1>
            <p className="text-text-muted text-sm">{typeLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/geofences/${geofence.id}/edit`}>Edit</Link>
            </Button>
            <DeleteGeofenceDialog id={geofence.id} name={geofence.name} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Configuration
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Name" value={geofence.name} />
            <DetailRow label="Type" value={typeLabel} />
            <DetailRow
              label="Customer"
              value={
                geofence.customerId === null ? (
                  "—"
                ) : (
                  <Link
                    href={`/customers/${geofence.customerId}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    {customer?.name ?? geofence.customerId}
                  </Link>
                )
              }
            />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Boundary
          </h2>
          {vertices.length > 0 ? (
            <div className="space-y-3">
              <p className="text-text-muted text-sm">
                Closed WGS84 ring (longitude, latitude) · {vertices.length} points.
              </p>
              <ol className="text-text-primary grid grid-cols-1 gap-1 font-mono text-sm tabular-nums sm:grid-cols-2">
                {vertices.map((vertex, index) => {
                  const [lon, lat] = vertex.split(",");
                  return (
                    <li key={index} className="flex gap-2">
                      <span className="text-text-muted select-none">{index + 1}.</span>
                      <span>
                        {lon}, {lat}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : (
            // Defensive: an unparseable WKT (a future storage-format change)
            // still renders the raw stored text rather than an empty section.
            <p className="text-text-primary font-mono text-sm break-all">{geofence.boundaryWkt}</p>
          )}
          <p className="text-text-muted mt-4 text-xs break-all">
            <span className="font-medium">Stored WKT:</span> {geofence.boundaryWkt}
          </p>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(geofence.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(geofence.updatedAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}
