import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DetailRow } from "@/components/ui/detail-row";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, ApiError } from "@/lib/api";
import { DRIVER_STATUS_LABELS, LICENSE_CLASS_LABELS } from "@/lib/drivers-schema";
import { formatHours } from "@/lib/units";

import { TRIP_STATUS_LABELS, type TripListItem, type TripStatus } from "../../trips/types";
import type { Driver } from "../types";
import { DeleteDriverDialog } from "./delete-driver-dialog";

// Cross-slice read — iter 10. The "Recent trips" section below issues
// a second authenticated fetch against the iter-8 `?driverId=` query
// param on the trips list endpoint. The section caps at 10 rows and
// surfaces a "View all →" link when the total exceeds that cap. The
// shape mirrors the trips list rows but omits `driver.fullName`
// (redundant — the page already names the driver) and shows
// `vehicle.registrationNumber` instead.
interface TripsListResponse {
  items: TripListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: string;
  sortDir: string;
}

// Cross-slice read — iter 13. "Lifetime stats" surfaces three scalar
// aggregations from `GET /api/v1/drivers/:id/stats`: count + km from
// COMPLETED trips, plus the vehicle paired with the most-recently-
// started trip (any non-null `startedAt`). Symmetric mirror of the
// iter-12 VehicleStatsResponse on the vehicle detail page. Inlining
// rather than shared-typing follows the same convention as
// TripsListResponse above — promotion waits until a second surface
// consumes it.
interface DriverStatsResponse {
  driverId: string;
  completedTripCount: number;
  totalKmLogged: number;
  // Engine-hours lifetime stat (ADR-0036), integer tenths-of-an-hour summed
  // across the driver's COMPLETED trips; 0 for a driver who never operated
  // hour-metered equipment. Shown only when > 0 (see the Lifetime stats card).
  totalHoursLogged: number;
  mostRecentVehicle: {
    id: string;
    registrationNumber: string;
    tripId: string;
    startedAt: string;
  } | null;
}

const RECENT_TRIPS_LIMIT = 10;

// Driver detail — iter 6 of the Drivers slice. Server-rendered shell
// (the (app) layout provides the auth gate);
// fetches the driver via apiFetch and surfaces 404 through Next.js's
// notFound() route so /drivers/<bogus-id> renders the framework's
// standard not-found page.
//
// Edit / Delete CTAs land in the header right-side cluster. Iter 7
// wired them up alongside the write-path endpoints (POST/PATCH/DELETE).
// The Delete button opens a confirmation dialog (DeleteDriverDialog,
// a small client island around shadcn's AlertDialog); the action layer
// (../actions.ts:deleteDriverAction) issues DELETE and redirects on
// success.
//
// Field layout: a definition list (<dl>) under DESIGN.md §"Data display"
// typography tokens. Two-column on >= sm; stacks on narrow viewports.
// Mirrors apps/web/src/app/vehicles/[id]/page.tsx in shape.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatKilometers(km: number): string {
  // Match the iter-12 vehicle detail page formatter (it in turn
  // matches the vehicles list page). Promoting to a shared module is
  // still deferred until a third surface needs it — the iter-12 PR
  // comment explicitly left that on the table.
  const formatter = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatter.format(km)} km`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// Render an ISO date+time as YYYY-MM-DD HH:MM (no seconds, no zone
// suffix). Matches `formatDateTime` in apps/web/src/app/trips/page.tsx
// and the mirror added to apps/web/src/app/vehicles/[id]/page.tsx in
// this iter.
function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

export default async function DriverDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const { id } = await params;

  let driver: Driver;
  try {
    driver = await apiFetch<Driver>(`/api/v1/drivers/${id}`);
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

  // Cross-slice reads: fetch the 10 most recent trips for this driver
  // and the lifetime stats. The two fetches are independent and run in
  // parallel via Promise.all; 401 on either → login (consistent with
  // the primary fetch above). Any other failure propagates to the
  // framework error boundary; see the mirroring comment in
  // apps/web/src/app/vehicles/[id]/page.tsx. Stats was added in iter
  // 13 to match the iter-12 surface added to the vehicle detail page.
  let trips: TripsListResponse;
  let stats: DriverStatsResponse;
  try {
    [trips, stats] = await Promise.all([
      apiFetch<TripsListResponse>(
        `/api/v1/trips?driverId=${encodeURIComponent(driver.id)}&sortBy=createdAt&sortDir=desc&take=${RECENT_TRIPS_LIMIT}`,
      ),
      apiFetch<DriverStatsResponse>(`/api/v1/drivers/${encodeURIComponent(driver.id)}/stats`),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb
              items={[
                { label: "FleetCo", href: "/" },
                { label: "Drivers", href: "/drivers" },
                { label: driver.fullName },
              ]}
            />
            <h1 className="text-text-primary text-2xl font-semibold">{driver.fullName}</h1>
            <p className="text-text-muted text-sm">
              {LICENSE_CLASS_LABELS[driver.licenseClass] ?? driver.licenseClass} ·{" "}
              {DRIVER_STATUS_LABELS[driver.status] ?? driver.status}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/drivers/${driver.id}/edit`}>Edit</Link>
            </Button>
            <DeleteDriverDialog id={driver.id} fullName={driver.fullName} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Full name" value={driver.fullName} />
            <DetailRow label="License number" value={driver.licenseNumber} mono />
            <DetailRow
              label="License class"
              value={LICENSE_CLASS_LABELS[driver.licenseClass] ?? driver.licenseClass}
            />
            <DetailRow label="Phone" value={driver.phone} mono />
            <DetailRow label="Date of birth" value={<NepaliDate iso={driver.dateOfBirth} />} />
            <DetailRow
              label="Status"
              value={DRIVER_STATUS_LABELS[driver.status] ?? driver.status}
            />
            <DetailRow label="Hired at" value={<NepaliDate iso={driver.hiredAt} />} />
            <DetailRow
              label="License expires"
              value={<NepaliDate iso={driver.licenseExpiresAt} />}
            />
            <DetailRow label="Terminated at" value={<NepaliDate iso={driver.terminatedAt} />} />
            <DetailRow label="Created at" value={formatTimestamp(driver.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(driver.updatedAt)} />
          </dl>
        </section>

        {/* Iter 13: lifetime stats card. Three scalars from the new
            GET /api/v1/drivers/:id/stats endpoint — the symmetric
            mirror of the iter-12 surface on the vehicle detail page.
            Most-recent-vehicle is a link to the vehicle detail page
            when present, using registrationNumber as the label per
            the glossary (the canonical short identifier in this
            domain). */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">
            Lifetime stats
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-3">
            <DetailRow label="Completed trips" value={String(stats.completedTripCount)} numeric />
            <DetailRow
              label="Total km logged"
              value={formatKilometers(stats.totalKmLogged)}
              numeric
            />
            {/* Engine-hours (ADR-0036): a driver may operate both km-metered
                trucks and hour-metered equipment. Show the hours total only
                when they have logged equipment hours, so a km-only driver's
                card stays uncluttered. */}
            {stats.totalHoursLogged > 0 ? (
              <DetailRow
                label="Total hours logged"
                value={formatHours(stats.totalHoursLogged)}
                numeric
              />
            ) : null}
            <DetailRow
              label="Most recent vehicle"
              value={
                stats.mostRecentVehicle ? (
                  <Link
                    href={`/vehicles/${stats.mostRecentVehicle.id}`}
                    className="text-text-primary hover:text-text-secondary font-mono underline-offset-2 hover:underline"
                  >
                    {stats.mostRecentVehicle.registrationNumber}
                  </Link>
                ) : (
                  "—"
                )
              }
            />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          <header className="border-border-subtle flex items-center justify-between gap-4 border-b px-6 py-4">
            <h2 className="text-text-muted text-xs font-medium uppercase tracking-wide">
              Recent trips
            </h2>
            {trips.total > RECENT_TRIPS_LIMIT ? (
              <Link
                href={`/trips?driverId=${encodeURIComponent(driver.id)}`}
                className="text-text-secondary hover:text-text-primary text-sm"
              >
                View all trips by this driver →
              </Link>
            ) : null}
          </header>
          {trips.items.length === 0 ? (
            <p className="text-text-secondary px-6 py-6 text-sm">No trips by this driver yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right tabular-nums">Started</TableHead>
                  <TableHead className="text-right tabular-nums">Ended</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trips.items.map((t) => (
                  // Stretched-link pattern mirrors the trips list: the
                  // first cell's anchor expands to cover the row.
                  <TableRow key={t.id} className="relative cursor-pointer">
                    <TableCell className="text-text-primary font-mono">
                      <Link
                        href={`/trips/${t.id}`}
                        className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                      >
                        {t.vehicle.registrationNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {TRIP_STATUS_LABELS[t.status as TripStatus] ?? t.status}
                    </TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {formatDateTime(t.startedAt)}
                    </TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {formatDateTime(t.endedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </main>
  );
}
