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
import { nextDueForSchedule, serviceScheduleState } from "@/lib/maintenance";
import { getServerSession } from "@/lib/session";
import {
  formatIntervalLabel,
  SERVICE_INTERVAL_TYPE_LABELS,
  SERVICE_SCHEDULE_STATUS_LABELS,
} from "@/lib/service-schedules-schema";
import { formatHours, formatKm } from "@/lib/units";

import { DeleteServiceScheduleDialog } from "./delete-service-schedule-dialog";
import type { ServiceSchedule } from "../types";
import type { ServiceRecord, ServiceRecordsListResponse } from "../../service-records/types";
import type { Vehicle } from "../../vehicles/types";

// Service-schedule detail — ADR-0037 B5. Server-rendered shell (auth gate;
// redirect to /login if absent); fetches the schedule via apiFetch and surfaces
// 404 through Next.js's notFound(). Mirrors apps/web/src/app/geofences/[id]/
// page.tsx in shape.
//
// The owning Vehicle is NOT nested in the schedule response, so it is resolved
// by a second fetch — needed both for the registration deep-link AND for the
// vehicle's CURRENT meter reading, which the B4 `serviceScheduleState` classifier
// measures the schedule against. The schedule's service history is fetched from
// the records endpoint filtered to this schedule.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// The schedule's derived "next due" (ADR-0037 c7): a BS-rendered date for the
// calendar dimension, a formatted km / hours reading for the meter dimensions.
// formatKm / formatHours render the em-dash on a null reading (the same inputs
// that make serviceScheduleState return "none").
function NextDueValue({ schedule }: { schedule: ServiceSchedule }): React.ReactElement {
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

// The schedule's last-service anchor reading, by dimension (the meter captured at
// the last service; calendar schedules have no meter anchor).
function anchorReading(schedule: ServiceSchedule): string {
  switch (schedule.intervalType) {
    case "DISTANCE_KM":
      return formatKm(schedule.lastServiceOdometerKm);
    case "ENGINE_HOURS":
      return formatHours(schedule.lastServiceEngineHours);
    case "CALENDAR_DAYS":
      return "—";
  }
}

export default async function ServiceScheduleDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let schedule: ServiceSchedule;
  try {
    schedule = await apiFetch<ServiceSchedule>(`/api/v1/service-schedules/${id}`);
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

  // Resolve the owning vehicle (for the registration + the current meter reading
  // the badge classifies against) and this schedule's service history. A 401 on
  // either redirects; any other failure propagates (the schedule already
  // rendered would be a worse half-state to swallow).
  let vehicle: Vehicle | null = null;
  let records: ServiceRecord[] = [];
  try {
    [vehicle, records] = await Promise.all([
      apiFetch<Vehicle>(`/api/v1/vehicles/${encodeURIComponent(schedule.vehicleId)}`),
      apiFetch<ServiceRecordsListResponse>(
        `/api/v1/service-records?serviceScheduleId=${encodeURIComponent(id)}&sortBy=performedAt&sortDir=desc&take=200`,
      ).then((r) => r.items),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const state = vehicle
    ? serviceScheduleState(
        schedule,
        {
          odometerCurrentKm: vehicle.odometerCurrentKm,
          engineHoursCurrent: vehicle.engineHoursCurrent,
        },
        new Date(),
      )
    : "none";

  const statusBadge =
    state === "overdue" ? (
      <Badge variant="error">Service overdue</Badge>
    ) : state === "due-soon" ? (
      <Badge variant="warning">Service due soon</Badge>
    ) : state === "ok" ? (
      <span className="text-text-muted text-sm">On track</span>
    ) : (
      <span className="text-text-muted text-sm">No reading yet</span>
    );

  const recordHref = `/service-records/new?vehicleId=${encodeURIComponent(schedule.vehicleId)}&serviceScheduleId=${encodeURIComponent(schedule.id)}`;

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
              <Link href="/service-schedules" className="hover:text-text-primary">
                Service schedules
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">{schedule.name}</span>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-text-primary text-2xl font-semibold">{schedule.name}</h1>
              {statusBadge}
            </div>
            <p className="text-text-muted text-sm">
              {SERVICE_INTERVAL_TYPE_LABELS[schedule.intervalType] ?? schedule.intervalType} ·{" "}
              {SERVICE_SCHEDULE_STATUS_LABELS[schedule.status] ?? schedule.status}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/service-schedules/${schedule.id}/edit`}>Edit</Link>
            </Button>
            <DeleteServiceScheduleDialog id={schedule.id} name={schedule.name} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Configuration
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Vehicle"
              value={
                <Link
                  href={`/vehicles/${schedule.vehicleId}`}
                  className="text-text-primary hover:text-text-secondary font-mono underline-offset-2 hover:underline"
                >
                  {vehicle?.registrationNumber ?? schedule.vehicleId}
                </Link>
              }
            />
            <DetailRow
              label="Interval"
              value={formatIntervalLabel(schedule.intervalType, schedule.intervalValue)}
            />
            <DetailRow label="Next due" value={<NextDueValue schedule={schedule} />} />
            <DetailRow
              label="Status"
              value={SERVICE_SCHEDULE_STATUS_LABELS[schedule.status] ?? schedule.status}
            />
            <DetailRow
              label="Last serviced at"
              value={<NepaliDate iso={schedule.lastServiceAt} />}
            />
            <DetailRow label="Reading at last service" value={anchorReading(schedule)} numeric />
            {schedule.description ? (
              <DetailRow
                label="Description"
                value={schedule.description}
                className="sm:col-span-2"
              />
            ) : null}
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          <header className="border-border-subtle flex items-center justify-between gap-4 border-b px-6 py-4">
            <h2 className="text-text-muted text-xs font-medium tracking-wide uppercase">
              Service history
            </h2>
            <Button asChild variant="outline" size="sm">
              <Link href={recordHref}>Record a service</Link>
            </Button>
          </header>
          {records.length === 0 ? (
            <p className="text-text-secondary px-6 py-6 text-sm">
              No services recorded against this schedule yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Performed</TableHead>
                  <TableHead className="text-right tabular-nums">Odometer</TableHead>
                  <TableHead className="text-right tabular-nums">Engine hours</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => (
                  <TableRow key={r.id} className="relative cursor-pointer">
                    <TableCell className="text-text-primary">
                      <Link
                        href={`/service-records/${r.id}`}
                        className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                      >
                        <NepaliDate iso={r.performedAt} />
                      </Link>
                    </TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {formatKm(r.odometerKm)}
                    </TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {formatHours(r.engineHours)}
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {r.notes && r.notes.length > 0 ? r.notes : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(schedule.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(schedule.updatedAt)} />
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
  // Definition-list row — DESIGN.md §"Data display": mono for identifiers,
  // tabular-nums for numeric, default sans otherwise. Mirror of the Geofences /
  // Jobs detail-page DetailRow.
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
