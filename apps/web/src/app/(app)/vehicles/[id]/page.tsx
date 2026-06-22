import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, ApiError } from "@/lib/api";
import { complianceBadgeState } from "@/lib/compliance";
import { nextDueForSchedule, serviceScheduleState } from "@/lib/maintenance";
import { getServerSession } from "@/lib/session";
import { formatHours, formatKm } from "@/lib/units";
import {
  INSURANCE_TYPE_LABELS,
  meterIncludesHours,
  meterIncludesOdometer,
  METER_TYPE_LABELS,
  VEHICLE_KIND_LABELS,
  VEHICLE_STATUS_LABELS,
} from "@/lib/vehicles-schema";

import { TRIP_STATUS_LABELS, type TripListItem, type TripStatus } from "../../trips/types";
import type { Vehicle } from "../types";
import { DeleteVehicleDialog } from "./delete-vehicle-dialog";

// Cross-slice read — iter 10. The "Recent trips" section below issues
// a second authenticated fetch against the iter-8 `?vehicleId=` query
// param on the trips list endpoint. The section caps at 10 rows and
// surfaces a "View all →" link when the total exceeds that cap. The
// shape mirrors the trips list rows but omits `vehicle.registrationNumber`
// (redundant — the page is already scoped to one vehicle) and omits
// the driver's `phone` (Tier 2 PII not needed at a glance).
interface TripsListResponse {
  items: TripListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: string;
  sortDir: string;
}

const RECENT_TRIPS_LIMIT = 10;

// Cross-slice read — iter 12. "Lifetime stats" surfaces three scalar
// aggregations from `GET /api/v1/vehicles/:id/stats`: count + km from
// COMPLETED trips, plus the driver of the most-recently-started trip
// (any non-null `startedAt`). Mirror of the API's VehicleStatsResponse
// in apps/api/src/modules/vehicles/vehicles.controller.ts. Inlining
// rather than shared-typing follows the same convention as
// TripsListResponse above — promotion to a shared module waits until
// a second surface consumes it.
interface VehicleStatsResponse {
  vehicleId: string;
  completedTripCount: number;
  totalKmLogged: number;
  // Engine-hours lifetime stat (ADR-0036), integer tenths-of-an-hour; 0 for a
  // km-only vehicle. Shown on the Lifetime stats card for hour-metered assets.
  totalHoursLogged: number;
  mostRecentDriver: {
    id: string;
    fullName: string;
    tripId: string;
    startedAt: string;
  } | null;
}

// Cross-slice read — B4 (ADR-0037). The "Service schedules" section fetches
// this vehicle's ACTIVE service schedules and paints a per-schedule
// due-soon/overdue <Badge> from `serviceScheduleState`. The wire shape is the
// raw ServiceSchedule row the API returns (apps/api maintenance aggregate);
// dates arrive as ISO strings, meter anchors as integers (km /
// tenths-of-an-hour) or null. Inlined per the same convention as
// TripsListResponse / VehicleStatsResponse — B5 (the maintenance web pages)
// will promote it to a shared type when a second surface consumes it. The
// shape is structurally assignable to maintenance.ts's `ServiceScheduleAnchor`
// (the classifier input).
interface ServiceScheduleRow {
  id: string;
  vehicleId: string;
  name: string;
  description: string | null;
  intervalType: "DISTANCE_KM" | "ENGINE_HOURS" | "CALENDAR_DAYS";
  intervalValue: number;
  status: "ACTIVE" | "INACTIVE";
  lastServiceAt: string;
  lastServiceOdometerKm: number | null;
  lastServiceEngineHours: number | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

interface ServiceSchedulesResponse {
  items: ServiceScheduleRow[];
  total: number;
  skip: number;
  take: number;
  sortBy: string;
  sortDir: string;
}

// Human-readable interval label, e.g. "Every 5,000 km" / "Every 250.0 h" /
// "Every 90 days". formatKm / formatHours come from lib/units (hours are
// integer tenths, so formatHours(2500) → "250.0 h").
function intervalLabel(schedule: ServiceScheduleRow): string {
  switch (schedule.intervalType) {
    case "DISTANCE_KM":
      return `Every ${formatKm(schedule.intervalValue)}`;
    case "ENGINE_HOURS":
      return `Every ${formatHours(schedule.intervalValue)}`;
    case "CALENDAR_DAYS":
      return `Every ${schedule.intervalValue} ${schedule.intervalValue === 1 ? "day" : "days"}`;
  }
}

// The schedule's derived "next due" value (ADR-0037 c7): a BS-rendered date for
// the calendar dimension, a formatted km / hours reading for the meter
// dimensions. formatKm / formatHours render the em-dash on a null reading (the
// same inputs that make serviceScheduleState return "none").
function NextDueCell({ schedule }: { schedule: ServiceScheduleRow }): React.ReactElement {
  const nextDue = nextDueForSchedule(schedule);
  switch (schedule.intervalType) {
    case "CALENDAR_DAYS":
      return nextDue.dateIso ? <NepaliDate iso={nextDue.dateIso} /> : <span>—</span>;
    case "DISTANCE_KM":
      return <span>{formatKm(nextDue.km)}</span>;
    case "ENGINE_HOURS":
      return <span>{formatHours(nextDue.engineHoursTenths)}</span>;
  }
}

// The per-schedule status cell. `serviceScheduleState` rotates the compliance
// badge state (ADR-0037 c7): overdue → red, due-soon → amber, ok → a quiet "On
// track", none → em-dash (no reading yet to classify). The <Badge> is the
// shipped status primitive — no new design token (the drift test stays green).
function ServiceStatusCell({
  schedule,
  vehicle,
}: {
  schedule: ServiceScheduleRow;
  vehicle: Vehicle;
}): React.ReactElement {
  const state = serviceScheduleState(
    schedule,
    {
      odometerCurrentKm: vehicle.odometerCurrentKm,
      engineHoursCurrent: vehicle.engineHoursCurrent,
    },
    new Date(),
  );
  if (state === "overdue") return <Badge variant="error">Service overdue</Badge>;
  if (state === "due-soon") return <Badge variant="warning">Service due soon</Badge>;
  if (state === "ok") return <span className="text-text-muted text-sm">On track</span>;
  return <span className="text-text-muted text-sm">—</span>;
}

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

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// Render a nullable string value, falling back to an em-dash for null /
// empty. Used by the iter-14 Compliance section's identifier fields.
function valueOrDash(value: string | null): string {
  return value && value.length > 0 ? value : "—";
}

// Render an ISO date+time as YYYY-MM-DD HH:MM (no seconds, no zone
// suffix — the trips list page uses the same minute-precision
// rendering). Matches `formatDateTime` in apps/web/src/app/trips/page.tsx.
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

// Iter N3 (ADR-0031 §E): a compliance-expiry date rendered with its status
// badge. `complianceBadgeState` classifies the stored expiry against now by
// UTC calendar day over the 30-day window (its own pure, tested logic); we
// paint a red "Expired" / amber "Expiring soon" <Badge> beside the date, and
// render NO badge for "ok" / "none" (the date stands alone). The existing
// <NepaliDate> render is preserved — the badge is additive, not a replacement.
// A <Badge> is a <span> (status, not action — DESIGN.md anti-pattern #2).
function ComplianceExpiry({ iso }: { iso: string | null }): React.ReactElement {
  const state = complianceBadgeState(iso, new Date());
  let badge: React.ReactElement | null = null;
  if (state === "expired") {
    badge = <Badge variant="error">Expired</Badge>;
  } else if (state === "expiring-soon") {
    badge = <Badge variant="warning">Expiring soon</Badge>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <NepaliDate iso={iso} />
      {badge}
    </span>
  );
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

  // Cross-slice reads: fetch the 10 most recent trips for this vehicle
  // and the lifetime stats. The two fetches are independent and run in
  // parallel via Promise.all; 401 on either → login (consistent with the
  // primary fetch above). Any other failure is allowed to propagate;
  // the user has already seen the vehicle, and a 5xx on a section fetch
  // is loud enough at the error-boundary that swallowing it would be
  // the worse outcome.
  let trips: TripsListResponse;
  let stats: VehicleStatsResponse;
  let schedules: ServiceSchedulesResponse;
  try {
    [trips, stats, schedules] = await Promise.all([
      apiFetch<TripsListResponse>(
        `/api/v1/trips?vehicleId=${encodeURIComponent(vehicle.id)}&sortBy=createdAt&sortDir=desc&take=${RECENT_TRIPS_LIMIT}`,
      ),
      apiFetch<VehicleStatsResponse>(`/api/v1/vehicles/${encodeURIComponent(vehicle.id)}/stats`),
      // ACTIVE schedules only — INACTIVE schedules are excluded from the
      // due/overdue surface (ADR-0037 c8f). take=200 is the list ceiling; a
      // single vehicle never has that many concurrent schedules.
      apiFetch<ServiceSchedulesResponse>(
        `/api/v1/service-schedules?vehicleId=${encodeURIComponent(vehicle.id)}&status=ACTIVE&take=200&sortBy=name&sortDir=asc`,
      ),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // Engine-hours (ADR-0036 c1/c6): the detail page shows km, hours, or both per
  // the asset's meter — an ENGINE_HOURS excavator shows hours where a truck
  // shows km, a BOTH asset shows both.
  const showOdometer = meterIncludesOdometer(vehicle.meterType);
  const showHours = meterIncludesHours(vehicle.meterType);

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
              label="Meter type"
              value={METER_TYPE_LABELS[vehicle.meterType] ?? vehicle.meterType}
            />
            {showOdometer ? (
              <>
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
              </>
            ) : null}
            {showHours ? (
              <>
                <DetailRow
                  label="Engine hours at acquisition"
                  value={formatHours(vehicle.engineHoursStart)}
                  numeric
                />
                <DetailRow
                  label="Engine hours current"
                  value={formatHours(vehicle.engineHoursCurrent)}
                  numeric
                />
              </>
            ) : null}
            <DetailRow label="Acquired at" value={<NepaliDate iso={vehicle.acquiredAt} />} />
            <DetailRow label="Retired at" value={<NepaliDate iso={vehicle.retiredAt} />} />
            <DetailRow label="Created at" value={formatTimestamp(vehicle.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(vehicle.updatedAt)} />
          </dl>
        </section>

        {/* Iter 14: compliance metadata. Nepal registration documents
            (Bluebook, insurance, route permit). Null fields render "—".
            Document numbers use mono per the identifier convention. */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">
            Compliance
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Bluebook number" value={valueOrDash(vehicle.bluebookNumber)} mono />
            <DetailRow
              label="Bluebook expires"
              value={<ComplianceExpiry iso={vehicle.bluebookExpiresAt} />}
            />
            <DetailRow label="Insurer" value={valueOrDash(vehicle.insurer)} />
            <DetailRow
              label="Insurance policy number"
              value={valueOrDash(vehicle.insurancePolicyNumber)}
              mono
            />
            <DetailRow
              label="Insurance type"
              value={
                vehicle.insuranceType
                  ? (INSURANCE_TYPE_LABELS[vehicle.insuranceType] ?? vehicle.insuranceType)
                  : "—"
              }
            />
            <DetailRow
              label="Insurance expires"
              value={<ComplianceExpiry iso={vehicle.insuranceExpiresAt} />}
            />
            <DetailRow
              label="Route permit number"
              value={valueOrDash(vehicle.routePermitNumber)}
              mono
            />
            <DetailRow
              label="Route permit expires"
              value={<ComplianceExpiry iso={vehicle.routePermitExpiresAt} />}
            />
          </dl>
        </section>

        {/* B4 (ADR-0037 c7): preventive-maintenance schedules. Per-schedule
            due-soon / overdue <Badge>, computed against this vehicle's current
            meter reading (km / engine-hours) or the wall clock (calendar) by
            `serviceScheduleState` — the rotation of the Compliance section's
            badge pattern. ACTIVE schedules only. The worst-of-N roll-up for the
            list / Home dashboard is a B5 follow-up. */}
        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          <header className="border-border-subtle flex items-center justify-between gap-4 border-b px-6 py-4">
            <h2 className="text-text-muted text-xs font-medium uppercase tracking-wide">
              Service schedules
            </h2>
          </header>
          {schedules.items.length === 0 ? (
            <p className="text-text-secondary px-6 py-6 text-sm">
              No active service schedules for this vehicle.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Interval</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="text-text-primary">{s.name}</TableCell>
                    <TableCell className="text-text-secondary">{intervalLabel(s)}</TableCell>
                    <TableCell className="text-text-secondary">
                      <NextDueCell schedule={s} />
                    </TableCell>
                    <TableCell>
                      <ServiceStatusCell schedule={s} vehicle={vehicle} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        {/* Iter 12: lifetime stats card. Three scalars from the new
            GET /api/v1/vehicles/:id/stats endpoint. Most-recent-driver
            is a link to the driver detail page when present — consistent
            with the driver-name linking in the trips table below. */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">
            Lifetime stats
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-3">
            <DetailRow label="Completed trips" value={String(stats.completedTripCount)} numeric />
            {showOdometer ? (
              <DetailRow
                label="Total km logged"
                value={formatKilometers(stats.totalKmLogged)}
                numeric
              />
            ) : null}
            {showHours ? (
              <DetailRow
                label="Total hours logged"
                value={formatHours(stats.totalHoursLogged)}
                numeric
              />
            ) : null}
            <DetailRow
              label="Most recent driver"
              value={
                stats.mostRecentDriver ? (
                  <Link
                    href={`/drivers/${stats.mostRecentDriver.id}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    {stats.mostRecentDriver.fullName}
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
                href={`/trips?vehicleId=${encodeURIComponent(vehicle.id)}`}
                className="text-text-secondary hover:text-text-primary text-sm"
              >
                View all trips on this vehicle →
              </Link>
            ) : null}
          </header>
          {trips.items.length === 0 ? (
            <p className="text-text-secondary px-6 py-6 text-sm">No trips on this vehicle yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
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
                    <TableCell className="text-text-primary">
                      <Link
                        href={`/trips/${t.id}`}
                        className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                      >
                        {t.driver.fullName}
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

interface DetailRowProps {
  label: string;
  // Accept ReactNode so callers can pass a <Link> (e.g., the
  // iter-12 "Most recent driver" cell). For the common case the
  // value is still a plain string.
  value: React.ReactNode;
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
