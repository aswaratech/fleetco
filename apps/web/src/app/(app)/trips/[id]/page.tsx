import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DetailRow } from "@/components/ui/detail-row";
import { apiFetch, ApiError } from "@/lib/api";

import {
  MATERIAL_TYPE_LABELS,
  TRIP_STATUS_BADGE,
  TRIP_STATUS_LABELS,
  type TripDetail,
} from "../types";
import { DeleteTripDialog } from "./delete-trip-dialog";

// Trip detail — iter 8 of the Trips slice. Server-rendered shell
// (the (app) layout provides the auth gate);
// fetches the trip via apiFetch and surfaces 404 through Next.js's
// notFound() route so /trips/<bogus-id> renders the framework's
// standard not-found page. Mirrors apps/web/src/app/drivers/[id]/page.tsx
// in shape.
//
// Iter 9 wired the Edit + Delete CTAs alongside the write-path
// endpoints (POST/PATCH/DELETE). The Delete button opens a
// confirmation dialog (DeleteTripDialog, a small client island around
// shadcn's AlertDialog); the action layer (../actions.ts:deleteTripAction)
// issues DELETE and redirects on success. The detail page renders the
// full Vehicle + Driver nested objects (`TripDetail`, the include
// shape on the API). Vehicle.registrationNumber and Driver.fullName
// link back to their own detail pages.
//
// Field layout: a definition list (<dl>) under DESIGN.md §"Data display"
// typography tokens. Two-column on >= sm; stacks on narrow viewports.
// The page groups fields into sections (Vehicle, Driver, Timing,
// Odometer, Audit) rather than a single flat list because the Trip
// aggregate is the densest record in the system and a flat layout
// becomes hard to scan.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatKm(km: number | null): string {
  if (km === null) return "—";
  return `${km.toLocaleString("en-US")} km`;
}

function formatDistance(start: number | null, end: number | null): string {
  if (start === null || end === null) return "—";
  const delta = end - start;
  // Surface negative deltas as-is (the API does not yet validate
  // end >= start; that arrives with the iter-9 write path's
  // CreateTripSchema/UpdateTripSchema). Rendering "-12 km" makes the
  // anomaly visible to the operator rather than hiding it.
  return `${delta.toLocaleString("en-US")} km`;
}

// Time-of-day (UTC) for a milestone row, paired with <NepaliDate> for the date.
function formatTimeUTC(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

// The dispatch → delivery milestones, in monotonic order (ADR-0047 c1/c3). Each
// is a nullable timestamp on the Trip; a reached milestone shows its BS date +
// time, an unreached one a muted em-dash — "where is this load" without a status
// explosion.
const MILESTONES: {
  key:
    | "offeredAt"
    | "acceptedAt"
    | "arrivedPickupAt"
    | "loadedAt"
    | "arrivedDropoffAt"
    | "deliveredAt";
  label: string;
}[] = [
  { key: "offeredAt", label: "Offered" },
  { key: "acceptedAt", label: "Accepted" },
  { key: "arrivedPickupAt", label: "Arrived at pickup" },
  { key: "loadedAt", label: "Loaded" },
  { key: "arrivedDropoffAt", label: "Arrived at drop-off" },
  { key: "deliveredAt", label: "Delivered" },
];

export default async function TripDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const { id } = await params;

  let trip: TripDetail;
  try {
    trip = await apiFetch<TripDetail>(`/api/v1/trips/${id}`);
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

  const statusLabel = TRIP_STATUS_LABELS[trip.status] ?? trip.status;
  const hasOrder =
    trip.materialType !== null ||
    trip.pickupSiteId !== null ||
    trip.dropoffSiteId !== null ||
    trip.offeredAt !== null;
  const materialValue =
    trip.materialType !== null
      ? `${MATERIAL_TYPE_LABELS[trip.materialType] ?? trip.materialType}${
          trip.materialNote ? ` — ${trip.materialNote}` : ""
        }`
      : "—";

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb
              items={[
                { label: "FleetCo", href: "/" },
                { label: "Trips", href: "/trips" },
                {
                  label: (
                    <>
                      {trip.vehicle.registrationNumber} · {trip.driver.fullName}
                    </>
                  ),
                },
              ]}
            />
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-text-primary text-2xl font-semibold">
                Trip · {trip.vehicle.registrationNumber}
              </h1>
              <Badge variant={TRIP_STATUS_BADGE[trip.status] ?? "neutral"}>{statusLabel}</Badge>
            </div>
            <p className="text-text-muted text-sm">
              {trip.startedAt ? formatDateTime(trip.startedAt) : "Not yet started"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/trips/${trip.id}/edit`}>Edit</Link>
            </Button>
            <DeleteTripDialog
              id={trip.id}
              summary={`${trip.vehicle.registrationNumber} · ${trip.driver.fullName}`}
            />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-primary mb-4 text-sm font-semibold uppercase tracking-wide">
            Vehicle
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Registration"
              value={
                <Link
                  href={`/vehicles/${trip.vehicle.id}`}
                  className="text-text-primary hover:text-text-secondary font-mono underline-offset-2 hover:underline"
                >
                  {trip.vehicle.registrationNumber}
                </Link>
              }
            />
            <DetailRow label="Make / Model" value={`${trip.vehicle.make} ${trip.vehicle.model}`} />
            <DetailRow label="Year" value={String(trip.vehicle.year)} numeric />
            <DetailRow label="Kind" value={trip.vehicle.kind} />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-primary mb-4 text-sm font-semibold uppercase tracking-wide">
            Driver
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Name"
              value={
                <Link
                  href={`/drivers/${trip.driver.id}`}
                  className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                >
                  {trip.driver.fullName}
                </Link>
              }
            />
            <DetailRow label="License number" value={trip.driver.licenseNumber} mono />
            <DetailRow label="License class" value={trip.driver.licenseClass} />
            <DetailRow label="Phone" value={trip.driver.phone} mono />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-primary mb-4 text-sm font-semibold uppercase tracking-wide">
            Order
          </h2>
          {hasOrder ? (
            <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <DetailRow label="Material" value={materialValue} className="sm:col-span-2" />
              <DetailRow
                label="Pickup site"
                value={
                  trip.pickupSite ? (
                    <Link
                      href={`/sites/${trip.pickupSite.id}`}
                      className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                    >
                      {trip.pickupSite.name}
                    </Link>
                  ) : (
                    "—"
                  )
                }
              />
              <DetailRow
                label="Drop-off site"
                value={
                  trip.dropoffSite ? (
                    <Link
                      href={`/sites/${trip.dropoffSite.id}`}
                      className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                    >
                      {trip.dropoffSite.name}
                    </Link>
                  ) : (
                    "—"
                  )
                }
              />
              <DetailRow label="Consignee" value={trip.consigneeName ?? "—"} />
              <DetailRow
                label="Consignee phone"
                value={
                  trip.consigneePhone ? (
                    <a
                      href={`tel:${trip.consigneePhone}`}
                      className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                    >
                      {trip.consigneePhone}
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
              <DetailRow
                label="Expected load count"
                value={trip.expectedLoadCount !== null ? String(trip.expectedLoadCount) : "—"}
                numeric
              />
              <DetailRow label="Docket" value={trip.docketNumber ?? "—"} mono />
              <DetailRow
                label="Special instructions"
                value={trip.specialInstructions ?? "—"}
                className="sm:col-span-2"
              />
            </dl>
          ) : (
            <p className="text-text-muted text-sm">Not yet dispatched.</p>
          )}
        </section>

        {hasOrder ? (
          <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
            <h2 className="text-text-primary mb-4 text-sm font-semibold uppercase tracking-wide">
              Progress
            </h2>
            {trip.status === "OFFERED" && !trip.acceptedAt ? (
              <p className="text-text-muted mb-4 text-sm">Awaiting driver acceptance.</p>
            ) : null}
            <ol className="space-y-3">
              {MILESTONES.map((m) => {
                const iso = trip[m.key];
                return (
                  <li key={m.key} className="flex items-baseline justify-between gap-4 text-sm">
                    <span className="text-text-secondary">{m.label}</span>
                    {iso ? (
                      <span className="text-text-primary tabular-nums">
                        <NepaliDate iso={iso} /> · {formatTimeUTC(iso)}
                      </span>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-primary mb-4 text-sm font-semibold uppercase tracking-wide">
            Timing
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Status" value={statusLabel} />
            <DetailRow label="Started" value={formatDateTime(trip.startedAt)} />
            <DetailRow label="Ended" value={formatDateTime(trip.endedAt)} />
            <DetailRow label="Notes" value={trip.notes ?? "—"} className="sm:col-span-2" />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-primary mb-4 text-sm font-semibold uppercase tracking-wide">
            Odometer
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Start" value={formatKm(trip.startOdometerKm)} numeric />
            <DetailRow label="End" value={formatKm(trip.endOdometerKm)} numeric />
            <DetailRow
              label="Distance"
              value={formatDistance(trip.startOdometerKm, trip.endOdometerKm)}
              numeric
            />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-primary mb-4 text-sm font-semibold uppercase tracking-wide">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Trip ID" value={trip.id} mono />
            <DetailRow label="Created by" value={trip.createdById} mono />
            <DetailRow label="Created at" value={formatTimestamp(trip.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(trip.updatedAt)} />
            <DetailRow label="Date" value={<NepaliDate iso={trip.startedAt} />} />
          </dl>
        </section>
      </div>
    </main>
  );
}
