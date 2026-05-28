import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { formatNpr } from "@/lib/money";
import { getServerSession } from "@/lib/session";
import { formatKm, formatLiters } from "@/lib/units";

import type { FuelLogDetail } from "../types";
import { DeleteFuelLogDialog } from "./delete-fuel-log-dialog";

// Fuel log detail — iter 19 of the Fuel-logs slice (read path). Server-
// rendered shell (auth gate via getServerSession; redirect to /login
// if absent); fetches the fuel log via apiFetch and surfaces 404
// through Next.js's notFound() route. Mirrors apps/web/src/app/jobs/
// [id]/page.tsx and the Trips detail page in shape.
//
// The detail renders the full nested Vehicle (always present — the FK
// is NOT NULL) and the full nested Trip when set (the FK is nullable).
// The vehicle registration number links back to /vehicles/<id> and the
// trip id (when present) links to /trips/<id> so an operator can pivot
// to the related records — the same cross-slice pivot the Trips detail
// page uses for its vehicle / driver and the Jobs detail page uses for
// its customer. Iter 20 adds Edit / Delete CTAs (no write path this
// iter).

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
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

export default async function FuelLogDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let fuelLog: FuelLogDetail;
  try {
    fuelLog = await apiFetch<FuelLogDetail>(`/api/v1/fuel-logs/${id}`);
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
              <Link href="/fuel-logs" className="hover:text-text-primary">
                Fuel logs
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary tabular-nums">{formatDate(fuelLog.date)}</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold tabular-nums">
              {formatDate(fuelLog.date)}
            </h1>
            <p className="text-text-muted text-sm">
              <span className="font-mono">{fuelLog.vehicle.registrationNumber}</span> ·{" "}
              {formatLiters(fuelLog.litersMl)} · {formatNpr(fuelLog.totalCostPaisa)}
            </p>
          </div>
          {/* Edit + Delete CTAs (iter 20). Mirror of the Jobs /
              Customers / Drivers / Vehicles header cluster. The
              Delete button opens a confirmation dialog (client
              island); Edit links to /fuel-logs/<id>/edit. */}
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/fuel-logs/${fuelLog.id}/edit`}>Edit</Link>
            </Button>
            <DeleteFuelLogDialog id={fuelLog.id} dateLabel={formatDate(fuelLog.date)} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Vehicle
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Registration"
              value={
                <Link
                  href={`/vehicles/${fuelLog.vehicle.id}`}
                  className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                >
                  {fuelLog.vehicle.registrationNumber}
                </Link>
              }
              mono
            />
            <DetailRow label="Kind" value={fuelLog.vehicle.kind} />
            <DetailRow
              label="Make / model"
              value={`${fuelLog.vehicle.make} ${fuelLog.vehicle.model}`}
            />
            <DetailRow label="Year" value={String(fuelLog.vehicle.year)} numeric />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Fuel log
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Date" value={formatDate(fuelLog.date)} numeric />
            <DetailRow label="Liters" value={formatLiters(fuelLog.litersMl)} numeric />
            <DetailRow
              label="Price / liter"
              value={formatNpr(fuelLog.pricePerLiterPaisa)}
              numeric
            />
            <DetailRow label="Total cost" value={formatNpr(fuelLog.totalCostPaisa)} numeric />
            <DetailRow label="Odometer" value={formatKm(fuelLog.odometerReadingKm)} numeric />
            <DetailRow label="Station" value={fuelLog.station ?? "—"} />
            <DetailRow label="Receipt number" value={fuelLog.receiptNumber ?? "—"} mono />
            <DetailRow label="Notes" value={fuelLog.notes ?? "—"} className="sm:col-span-2" />
          </dl>
        </section>

        {fuelLog.trip ? (
          <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
            <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
              Trip
            </h2>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <DetailRow
                label="Trip"
                value={
                  <Link
                    href={`/trips/${fuelLog.trip.id}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    View trip
                  </Link>
                }
              />
              <DetailRow label="Status" value={fuelLog.trip.status} />
            </dl>
          </section>
        ) : null}

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(fuelLog.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(fuelLog.updatedAt)} />
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
  // Definition-list row — DESIGN.md §"Data display": mono for
  // identifiers (vehicle registration, receipt number), tabular-nums
  // for numeric, default sans otherwise. Accepts a ReactNode so the
  // vehicle registration and trip link can be <Link>s. Mirror of the
  // Jobs / Trips / Customers detail-page DetailRow.
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
      <dt className="text-text-muted text-xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
