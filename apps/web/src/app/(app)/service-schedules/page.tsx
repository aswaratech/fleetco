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
import {
  formatIntervalLabel,
  SERVICE_SCHEDULE_STATUS_LABELS,
} from "@/lib/service-schedules-schema";

import { ServiceSchedulesFilters } from "./service-schedules-filters";
import type { ServiceSchedule, ServiceSchedulesListResponse } from "./types";

// Service-schedules list — ADR-0037 B5 (web admin CRUD scaffold). Server-
// rendered; reads the session cookie, redirects to /login if absent, and fetches
// the list from the B3 API (apps/api owns the auth handler per ADR-0021; the
// maintenance aggregate is AuthGuard-only, so the web app does no extra
// role-gating — mirroring the other aggregates).
//
// Mirrors apps/web/src/app/geofences/page.tsx in shape:
//   - Filters: vehicle (a picker of the fleet) + status (ACTIVE / INACTIVE). The
//     API accepts both as query params.
//   - Sort: clickable headers on the two whitelisted sortable columns (name,
//     createdAt). Click toggles sortDir; a different column resets to that
//     column desc.
//   - Pagination: numbered page links; DEFAULT_PAGE_SIZE 20 matches the API's
//     LIST_TAKE_DEFAULT; "Showing M–N of T" per DESIGN.md §Tables.
//
// VEHICLE REGISTRATION RESOLUTION: the schedule list response carries only
// `vehicleId` (it does not nest the Vehicle). The owning registration is
// resolved by fetching the vehicles list ONCE (take=200, by registration) and
// mapping id → registration — cheaper than a per-row fetch for a sub-hundred-
// vehicle fleet, and the same enrichment the Geofences list uses for customer
// names. A vehicleId not in the first 200 (or a failed enrichment fetch) falls
// back to the raw id. The same fetch feeds the filter's vehicle picker.
//
// The list deliberately shows the lifecycle STATUS (ACTIVE / INACTIVE), not the
// due/overdue badge — "what needs attention" is the dedicated due-list's job
// (/service-schedules/due), the same separation the vehicles list draws from the
// Home compliance card. See DESIGN.md §"Surfaces" → "Preventive maintenance".

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

const DEFAULT_PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function ServiceSchedulesPage({
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const vehicleId = single(params.vehicleId);
  const status = single(params.status);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(vehicleId) || Boolean(status);

  // Forward only the params the API knows about; unknown query keys would 400
  // (the schema is .strict()). skip/take defaults applied here so every request
  // is explicit.
  const apiQuery = new URLSearchParams();
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);
  if (status) apiQuery.set("status", status);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: ServiceSchedulesListResponse;
  let vehicles: VehicleOption[] = [];
  try {
    [data, vehicles] = await Promise.all([
      apiFetch<ServiceSchedulesListResponse>(`/api/v1/service-schedules?${apiQuery.toString()}`),
      apiFetch<VehiclesListResponse>(
        "/api/v1/vehicles?sortBy=registrationNumber&sortDir=asc&take=200",
      ).then((r) => r.items),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const registrationById = new Map<string, string>();
  for (const v of vehicles) registrationById.set(v.id, v.registrationNumber);

  // The in-page links operate on the URL's params (not the API-mangled set,
  // which always carries explicit skip/take).
  const urlSearchParams = new URLSearchParams();
  if (vehicleId) urlSearchParams.set("vehicleId", vehicleId);
  if (status) urlSearchParams.set("status", status);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Service schedules" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Service schedules</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No schedules match the current filters."
                  : "No service schedules defined."
                : `${data.total} defined.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/service-schedules/due">Services due</Link>
            </Button>
            <Button asChild>
              <Link href="/service-schedules/new">New schedule</Link>
            </Button>
          </div>
        </header>

        <ServiceSchedulesFilters vehicleId={vehicleId} status={status} vehicles={vehicles} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No schedules match the current filters.</p>
              ) : (
                <>
                  <p>No service schedules defined.</p>
                  <p>
                    <Link
                      href="/service-schedules/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Define the first service schedule.
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
                      basePath="/service-schedules"
                      column="name"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Name
                    </SortableHeader>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Interval</TableHead>
                    <TableHead>Status</TableHead>
                    <SortableHeader
                      basePath="/service-schedules"
                      column="createdAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Created
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((s: ServiceSchedule) => (
                    <TableRow key={s.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary">
                        <Link
                          href={`/service-schedules/${s.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        <Link
                          href={`/vehicles/${s.vehicleId}`}
                          className="hover:text-text-primary relative z-10 font-mono"
                        >
                          {registrationById.get(s.vehicleId) ?? s.vehicleId}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {formatIntervalLabel(s.intervalType, s.intervalValue)}
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {SERVICE_SCHEDULE_STATUS_LABELS[s.status] ?? s.status}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={s.createdAt} format="bs" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/service-schedules"
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
