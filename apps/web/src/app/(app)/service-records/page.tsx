import Link from "next/link";
import { redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";
import { formatHours, formatKm } from "@/lib/units";

import { ServiceRecordsFilters } from "./service-records-filters";
import type { ServiceRecord, ServiceRecordsListResponse } from "./types";

// Service-records list — ADR-0037 B5. The completed-service history. Server-
// rendered; reads the session cookie, redirects to /login if absent, fetches the
// list from the B3 API. Mirrors the service-schedules list in shape.
//
// Two enrichment fetches resolve the bare row's FKs to human labels (the
// Geofences enrichment pattern): the vehicles list (id → registration) and the
// schedules list (id → name). A record with a null serviceScheduleId is an
// ad-hoc / one-off service and renders "Ad-hoc". The cost (the linked
// ExpenseLog's amount) is shown on the detail page, not the list, to keep the
// list to two enrichment fetches.
//
// Filters: vehicle + schedule. Sort: performedAt (default desc) / createdAt.

interface VehicleOption {
  id: string;
  registrationNumber: string;
}

interface VehiclesListResponse {
  items: VehicleOption[];
  total: number;
  skip: number;
  take: number;
}

interface ScheduleRow {
  id: string;
  name: string;
  vehicleId: string;
}

interface SchedulesListResponse {
  items: ScheduleRow[];
  total: number;
  skip: number;
  take: number;
}

const DEFAULT_PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function ServiceRecordsPage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const vehicleId = single(params.vehicleId);
  const serviceScheduleId = single(params.serviceScheduleId);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(vehicleId) || Boolean(serviceScheduleId);

  const apiQuery = new URLSearchParams();
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);
  if (serviceScheduleId) apiQuery.set("serviceScheduleId", serviceScheduleId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: ServiceRecordsListResponse;
  let vehicles: VehicleOption[] = [];
  let schedules: ScheduleRow[] = [];
  try {
    [data, vehicles, schedules] = await Promise.all([
      apiFetch<ServiceRecordsListResponse>(`/api/v1/service-records?${apiQuery.toString()}`),
      apiFetch<VehiclesListResponse>(
        "/api/v1/vehicles?sortBy=registrationNumber&sortDir=asc&take=200",
      ).then((r) => r.items),
      apiFetch<SchedulesListResponse>("/api/v1/service-schedules?sortBy=name&sortDir=asc&take=200")
        .then((r) => r.items)
        .catch(() => []),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const registrationById = new Map<string, string>();
  for (const v of vehicles) registrationById.set(v.id, v.registrationNumber);
  const scheduleNameById = new Map<string, string>();
  for (const s of schedules) scheduleNameById.set(s.id, s.name);

  // Schedule filter options labelled with their vehicle registration so two
  // like-named schedules on different vehicles are distinguishable.
  const scheduleOptions = schedules.map((s) => ({
    id: s.id,
    label: `${s.name} · ${registrationById.get(s.vehicleId) ?? s.vehicleId}`,
  }));

  const urlSearchParams = new URLSearchParams();
  if (vehicleId) urlSearchParams.set("vehicleId", vehicleId);
  if (serviceScheduleId) urlSearchParams.set("serviceScheduleId", serviceScheduleId);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Service history" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Service history</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No services match the current filters."
                  : "No services recorded."
                : `${data.total} recorded.`}
            </p>
          </div>
          <Button asChild>
            <Link href="/service-records/new">Record a service</Link>
          </Button>
        </header>

        <ServiceRecordsFilters
          vehicleId={vehicleId}
          serviceScheduleId={serviceScheduleId}
          vehicles={vehicles}
          schedules={scheduleOptions}
        />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No services match the current filters.</p>
              ) : (
                <>
                  <p>No services recorded.</p>
                  <p>
                    <Link
                      href="/service-records/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Record the first service.
                    </Link>
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader
                      basePath="/service-records"
                      column="performedAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Performed
                    </SortableHeader>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead className="text-right tabular-nums">Odometer</TableHead>
                    <TableHead className="text-right tabular-nums">Engine hours</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((r: ServiceRecord) => (
                    <TableRow key={r.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary">
                        <Link
                          href={`/service-records/${r.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          <NepaliDate iso={r.performedAt} format="bs" />
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        <Link
                          href={`/vehicles/${r.vehicleId}`}
                          className="hover:text-text-primary relative z-10 font-mono"
                        >
                          {registrationById.get(r.vehicleId) ?? r.vehicleId}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {r.serviceScheduleId === null ? (
                          <span className="text-text-muted">Ad-hoc</span>
                        ) : (
                          <Link
                            href={`/service-schedules/${r.serviceScheduleId}`}
                            className="hover:text-text-primary relative z-10"
                          >
                            {scheduleNameById.get(r.serviceScheduleId) ?? r.serviceScheduleId}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatKm(r.odometerKm)}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatHours(r.engineHours)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/service-records"
                total={data.total}
                skip={data.skip}
                take={data.take}
                searchParams={urlSearchParams}
              />
            </>
          )}
        </section>
      </div>
    </main>
  );
}
