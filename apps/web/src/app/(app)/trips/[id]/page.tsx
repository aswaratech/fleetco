import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { TRIP_STATUS_LABELS, type TripDetail } from "../types";
import { DeleteTripDialog } from "./delete-trip-dialog";

// Trip detail — iter 8 of the Trips slice. Server-rendered shell
// (auth gate via getServerSession; redirect to /login if absent);
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

export default async function TripDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

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

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
              <Link href="/" className="hover:text-text-primary">
                FleetCo
              </Link>
              <span aria-hidden="true"> › </span>
              <Link href="/trips" className="hover:text-text-primary">
                Trips
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">
                {trip.vehicle.registrationNumber} · {trip.driver.fullName}
              </span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">
              Trip · {trip.vehicle.registrationNumber}
            </h1>
            <p className="text-text-muted text-sm">
              {statusLabel} · {trip.startedAt ? formatDateTime(trip.startedAt) : "Not yet started"}
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

interface DetailRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  numeric?: boolean;
  className?: string;
}

function DetailRow({ label, value, mono, numeric, className }: DetailRowProps): React.ReactElement {
  // Definition-list row — DESIGN.md §"Data display": Latin numerals,
  // tabular-nums for numeric values, mono for identifiers. Accepts a
  // ReactNode so it can render a <Link> for the registration /
  // driver-name pivot links.
  const valueClass = [
    "text-text-primary text-sm",
    mono ? "font-mono" : "",
    numeric ? "tabular-nums" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const wrapperClass = ["space-y-1", className].filter(Boolean).join(" ");
  return (
    <div className={wrapperClass}>
      <dt className="text-text-muted text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
