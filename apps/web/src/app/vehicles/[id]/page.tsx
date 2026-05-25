import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";
import { VEHICLE_KIND_LABELS, VEHICLE_STATUS_LABELS } from "@/lib/vehicles-schema";

import type { Vehicle } from "../types";
import { DeleteVehicleDialog } from "./delete-vehicle-dialog";

// Vehicle detail — iter 3 of the Vehicles slice. Server-rendered shell
// (auth gate via getServerSession; redirect to /login if absent); fetches
// the vehicle via apiFetch and surfaces 404 through Next.js's notFound()
// route so /vehicles/<bogus-id> renders the framework's standard
// not-found page. Edit and Delete CTAs sit in the page header; the
// delete confirmation is a small client island (AlertDialog is Radix
// portal-backed and needs interactive state).
//
// Field layout: a definition list (<dl>) under DESIGN.md §"Data display"
// typography tokens — no new shadcn primitive is introduced for this
// iteration. Two-column on >= sm; stacks on narrow viewports.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatKilometers(km: number): string {
  // Match the list page's formatter (apps/web/src/app/vehicles/page.tsx).
  // Promoting to a shared module is deferred until a third surface needs it.
  const formatter = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatter.format(km)} km`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // Render YYYY-MM-DD in en-IN; BS-calendar rendering arrives with the
  // <NepaliDate> component documented in DESIGN.md §"BS calendar".
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function VehicleDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let vehicle: Vehicle;
  try {
    vehicle = await apiFetch<Vehicle>(`/api/v1/vehicles/${id}`);
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
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
              <Link href="/" className="hover:text-text-primary">
                FleetCo
              </Link>
              <span aria-hidden="true"> › </span>
              <Link href="/vehicles" className="hover:text-text-primary">
                Vehicles
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary font-mono">{vehicle.registrationNumber}</span>
            </nav>
            <h1 className="text-text-primary font-mono text-2xl font-semibold">
              {vehicle.registrationNumber}
            </h1>
            <p className="text-text-muted text-sm">
              {VEHICLE_KIND_LABELS[vehicle.kind] ?? vehicle.kind} ·{" "}
              {VEHICLE_STATUS_LABELS[vehicle.status] ?? vehicle.status}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/vehicles/${vehicle.id}/edit`}>Edit</Link>
            </Button>
            <DeleteVehicleDialog id={vehicle.id} registrationNumber={vehicle.registrationNumber} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Registration number" value={vehicle.registrationNumber} mono />
            <DetailRow label="Kind" value={VEHICLE_KIND_LABELS[vehicle.kind] ?? vehicle.kind} />
            <DetailRow label="Make" value={vehicle.make} />
            <DetailRow label="Model" value={vehicle.model} />
            <DetailRow label="Year" value={String(vehicle.year)} numeric />
            <DetailRow
              label="Status"
              value={VEHICLE_STATUS_LABELS[vehicle.status] ?? vehicle.status}
            />
            <DetailRow
              label="Odometer at acquisition"
              value={formatKilometers(vehicle.odometerStartKm)}
              numeric
            />
            <DetailRow
              label="Odometer current"
              value={formatKilometers(vehicle.odometerCurrentKm)}
              numeric
            />
            <DetailRow label="Acquired at" value={formatDate(vehicle.acquiredAt)} />
            <DetailRow label="Retired at" value={formatDate(vehicle.retiredAt)} />
            <DetailRow label="Created at" value={formatTimestamp(vehicle.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(vehicle.updatedAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}

interface DetailRowProps {
  label: string;
  value: string;
  mono?: boolean;
  numeric?: boolean;
}

function DetailRow({ label, value, mono, numeric }: DetailRowProps): React.ReactElement {
  // Definition-list row — DESIGN.md §"Data display": Latin numerals,
  // tabular-nums for numeric values, mono for identifiers (registration
  // number), default sans for everything else. Label sits in
  // color.text.muted; value in color.text.primary.
  const valueClass = [
    "text-text-primary text-sm",
    mono ? "font-mono" : "",
    numeric ? "tabular-nums" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1">
      <dt className="text-text-muted text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
