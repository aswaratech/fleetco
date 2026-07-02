import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DetailRow } from "@/components/ui/detail-row";
import { apiFetch, ApiError } from "@/lib/api";
import { TRACKER_STATUS_BADGE_VARIANTS, TRACKER_STATUS_LABELS } from "@/lib/trackers-schema";
import { getServerSession } from "@/lib/session";

import type { Tracker } from "../types";

// Tracker detail — ADR-0042 M4 (read path). Server-rendered shell (auth
// gate via getServerSession; redirect to /login if absent); fetches the
// tracker via apiFetch and surfaces 404 through Next.js's notFound() route.
// Mirrors the geofences detail page in shape.
//
// The assigned vehicle is nested in the response (a two-field projection),
// so no enrichment fetch is needed; the row deep-links to /vehicles/<id>.
// There is NO delete dialog: the API exposes no delete route (ADR-0042 —
// unassign frees the vehicle slot; RETIRED ends the lifecycle).

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function TrackerDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let tracker: Tracker;
  try {
    tracker = await apiFetch<Tracker>(`/api/v1/telematics/trackers/${id}`);
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

  const statusLabel = TRACKER_STATUS_LABELS[tracker.status] ?? tracker.status;

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb
              items={[
                { label: "FleetCo", href: "/" },
                { label: "Trackers", href: "/trackers" },
                { label: tracker.imei, className: "font-mono" },
              ]}
            />
            <h1 className="text-text-primary font-mono text-2xl font-semibold">{tracker.imei}</h1>
            <p className="text-text-muted text-sm">
              {tracker.label ?? "GPS tracker"} · {statusLabel}
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href={`/trackers/${tracker.id}/edit`}>Edit</Link>
          </Button>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Device
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="IMEI" value={tracker.imei} mono />
            <DetailRow
              label="Status"
              value={
                <Badge variant={TRACKER_STATUS_BADGE_VARIANTS[tracker.status]}>{statusLabel}</Badge>
              }
            />
            <DetailRow label="Label" value={tracker.label ?? "—"} />
            <DetailRow label="SIM number" value={tracker.simMsisdn ?? "—"} mono />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Assignment
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Vehicle"
              value={
                tracker.vehicle === null ? (
                  "—"
                ) : (
                  <Link
                    href={`/vehicles/${tracker.vehicle.id}`}
                    className="text-text-primary font-mono underline-offset-2 hover:underline"
                  >
                    {tracker.vehicle.registrationNumber}
                  </Link>
                )
              }
            />
            <DetailRow
              label="Installed at"
              value={
                tracker.installedAt === null ? (
                  "—"
                ) : (
                  <NepaliDate iso={tracker.installedAt} format="bs" />
                )
              }
            />
          </dl>
          {tracker.status === "ACTIVE" && tracker.vehicleId === null ? (
            <p className="text-status-warning mt-4 text-sm">
              This tracker is Active but not assigned to a vehicle — its positions are dropped until
              it is assigned.
            </p>
          ) : null}
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(tracker.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(tracker.updatedAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}
