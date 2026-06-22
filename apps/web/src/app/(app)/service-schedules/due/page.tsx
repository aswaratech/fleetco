import Link from "next/link";
import { redirect } from "next/navigation";

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
import {
  nextDueForSchedule,
  serviceScheduleState,
  worstServiceState,
  type ScheduleWithReading,
  type ServiceScheduleState,
} from "@/lib/maintenance";
import { getServerSession } from "@/lib/session";
import { formatIntervalLabel } from "@/lib/service-schedules-schema";
import { formatHours, formatKm } from "@/lib/units";

import type { ServiceSchedule, ServiceSchedulesListResponse } from "../types";
import type { Vehicle } from "../../vehicles/types";

// Service due-list — ADR-0037 B5. The at-a-glance "what is due now" surface. It
// fetches all ACTIVE schedules + the fleet's vehicles, classifies each schedule
// with the B4 `serviceScheduleState` against its vehicle's CURRENT meter reading,
// keeps only the due-soon / overdue ones, and GROUPS them by vehicle — each
// vehicle section headed by its registration (deep-link) and a single worst-of
// <Badge> (`worstServiceState`, the rotation of `worstComplianceState`), with a
// small table of that vehicle's due/overdue schedules beneath.
//
// Bounded by the same take=200 ceiling the Home dashboard documents: a fleet
// with more than 200 active schedules or more than 200 vehicles would not be
// fully scanned (a muted note flags it when the cap is hit). Server-rendered;
// no new endpoint — it composes the existing schedule + vehicle list reads.

const SCAN_TAKE = 200;

// A vehicle that has at least one due-soon / overdue schedule, with those
// schedules and the per-vehicle worst-of state for the section badge.
interface DueVehicleGroup {
  vehicle: Vehicle;
  worst: ServiceScheduleState; // "overdue" | "due-soon" (a group only exists if non-ok)
  schedules: { schedule: ServiceSchedule; state: ServiceScheduleState }[];
}

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

function StatusBadge({ state }: { state: ServiceScheduleState }): React.ReactElement {
  if (state === "overdue") return <Badge variant="error">Service overdue</Badge>;
  if (state === "due-soon") return <Badge variant="warning">Service due soon</Badge>;
  // The due-list only ever shows due-soon/overdue rows, so this branch is
  // defensive (keeps the union exhaustive).
  return <span className="text-text-muted text-sm">On track</span>;
}

export default async function ServiceDuePage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let schedulesResponse: ServiceSchedulesListResponse;
  let vehicles: Vehicle[] = [];
  let vehiclesTotal = 0;
  try {
    const [schedulesRes, vehiclesRes] = await Promise.all([
      apiFetch<ServiceSchedulesListResponse>(
        `/api/v1/service-schedules?status=ACTIVE&take=${SCAN_TAKE}&sortBy=name&sortDir=asc`,
      ),
      apiFetch<{ items: Vehicle[]; total: number }>(
        `/api/v1/vehicles?sortBy=registrationNumber&sortDir=asc&take=${SCAN_TAKE}`,
      ),
    ]);
    schedulesResponse = schedulesRes;
    vehicles = vehiclesRes.items;
    vehiclesTotal = vehiclesRes.total;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const vehicleById = new Map<string, Vehicle>();
  for (const v of vehicles) vehicleById.set(v.id, v);

  const now = new Date();

  // Group due-soon / overdue schedules by vehicle. A schedule whose vehicle is
  // outside the scanned 200, or whose state is ok / none, is skipped.
  const groups = new Map<string, DueVehicleGroup>();
  for (const schedule of schedulesResponse.items) {
    const vehicle = vehicleById.get(schedule.vehicleId);
    if (!vehicle) continue;
    const reading = {
      odometerCurrentKm: vehicle.odometerCurrentKm,
      engineHoursCurrent: vehicle.engineHoursCurrent,
    };
    const state = serviceScheduleState(schedule, reading, now);
    if (state !== "overdue" && state !== "due-soon") continue;

    let group = groups.get(vehicle.id);
    if (!group) {
      group = { vehicle, worst: "none", schedules: [] };
      groups.set(vehicle.id, group);
    }
    group.schedules.push({ schedule, state });
  }

  // Per-vehicle worst-of badge via `worstServiceState` (do NOT re-derive the
  // precedence) over the vehicle's due schedules.
  for (const group of groups.values()) {
    const pairs: ScheduleWithReading[] = group.schedules.map(({ schedule }) => ({
      schedule,
      vehicle: {
        odometerCurrentKm: group.vehicle.odometerCurrentKm,
        engineHoursCurrent: group.vehicle.engineHoursCurrent,
      },
    }));
    group.worst = worstServiceState(pairs, now);
    // Within a vehicle, show overdue schedules before due-soon ones.
    group.schedules.sort((a, b) => severityRank(b.state) - severityRank(a.state));
  }

  // Order vehicle sections: any-overdue vehicles first, then by registration.
  const orderedGroups = Array.from(groups.values()).sort((a, b) => {
    const byWorst = severityRank(b.worst) - severityRank(a.worst);
    if (byWorst !== 0) return byWorst;
    return a.vehicle.registrationNumber.localeCompare(b.vehicle.registrationNumber);
  });

  const dueScheduleCount = orderedGroups.reduce((sum, g) => sum + g.schedules.length, 0);
  const capHit = schedulesResponse.total > SCAN_TAKE || vehiclesTotal > SCAN_TAKE;

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-4xl space-y-6 px-8 py-8">
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
              <span className="text-text-secondary">Due</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">Services due</h1>
            <p className="text-text-muted text-sm">
              {dueScheduleCount === 0
                ? "Every active schedule is on track."
                : `${dueScheduleCount} ${dueScheduleCount === 1 ? "schedule" : "schedules"} due across ${orderedGroups.length} ${orderedGroups.length === 1 ? "vehicle" : "vehicles"}.`}
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/service-schedules">All schedules</Link>
          </Button>
        </header>

        {capHit ? (
          <p className="text-text-muted text-xs">
            Showing the first {SCAN_TAKE} active schedules and {SCAN_TAKE} vehicles. A larger fleet
            needs a dedicated count — the same bound the Home dashboard documents.
          </p>
        ) : null}

        {orderedGroups.length === 0 ? (
          <section className="border-border-subtle bg-surface-raised rounded border p-8 shadow-sm">
            <p className="text-text-secondary text-sm">
              No services due. Every active schedule is on track.
            </p>
          </section>
        ) : (
          <div className="space-y-6">
            {orderedGroups.map((group) => (
              <section
                key={group.vehicle.id}
                className="border-border-subtle bg-surface-raised rounded border shadow-sm"
              >
                <header className="border-border-subtle flex items-center justify-between gap-4 border-b px-6 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <Link
                      href={`/vehicles/${group.vehicle.id}`}
                      className="text-text-primary hover:text-text-secondary font-mono text-sm font-semibold"
                    >
                      {group.vehicle.registrationNumber}
                    </Link>
                    {group.worst === "overdue" ? (
                      <Badge variant="error">Service overdue</Badge>
                    ) : (
                      <Badge variant="warning">Service due soon</Badge>
                    )}
                  </div>
                </header>
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
                    {group.schedules.map(({ schedule, state }) => (
                      <TableRow key={schedule.id} className="relative cursor-pointer">
                        <TableCell className="text-text-primary">
                          <Link
                            href={`/service-schedules/${schedule.id}`}
                            className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                          >
                            {schedule.name}
                          </Link>
                        </TableCell>
                        <TableCell className="text-text-secondary">
                          {formatIntervalLabel(schedule.intervalType, schedule.intervalValue)}
                        </TableCell>
                        <TableCell className="text-text-secondary">
                          <NextDueValue schedule={schedule} />
                        </TableCell>
                        <TableCell>
                          <StatusBadge state={state} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// Severity ordering for sorting (higher = more urgent). Mirrors the maintenance
// SERVICE_RANK precedence used by worstServiceState, but local to the sort.
function severityRank(state: ServiceScheduleState): number {
  switch (state) {
    case "overdue":
      return 3;
    case "due-soon":
      return 2;
    case "ok":
      return 1;
    case "none":
      return 0;
  }
}
