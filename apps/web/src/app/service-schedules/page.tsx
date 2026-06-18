import Link from "next/link";
import { redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
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

type SortColumn = "name" | "createdAt";
type SortDir = "asc" | "desc";

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

// Build the link for a pagination control. Filter and sort values are preserved;
// only `skip` changes. Omit the key at page 0 so the canonical URL stays clean.
function paginationParams(searchParams: URLSearchParams, nextSkip: number): string {
  const next = new URLSearchParams(searchParams);
  if (nextSkip === 0) {
    next.delete("skip");
  } else {
    next.set("skip", String(nextSkip));
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

// Build the link for a sortable column header. Toggles dir on the active column,
// else sets the new column desc.
function sortParams(
  searchParams: URLSearchParams,
  column: SortColumn,
  activeColumn: SortColumn,
  activeDir: SortDir,
): string {
  const next = new URLSearchParams(searchParams);
  if (column === activeColumn) {
    next.set("sortDir", activeDir === "asc" ? "desc" : "asc");
    next.set("sortBy", column);
  } else {
    next.set("sortBy", column);
    next.set("sortDir", "desc");
  }
  next.delete("skip");
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

function SortArrow({ direction }: { direction: SortDir }): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="ml-1 inline size-3 align-[-1px]"
    >
      {direction === "asc" ? <path d="m18 15-6-6-6 6" /> : <path d="m6 9 6 6 6-6" />}
    </svg>
  );
}

interface SortableHeaderProps {
  column: SortColumn;
  activeColumn: SortColumn;
  activeDir: SortDir;
  searchParams: URLSearchParams;
  className?: string;
  children: React.ReactNode;
}

function SortableHeader({
  column,
  activeColumn,
  activeDir,
  searchParams,
  className,
  children,
}: SortableHeaderProps): React.ReactElement {
  const isActive = column === activeColumn;
  const href = `/service-schedules${sortParams(searchParams, column, activeColumn, activeDir)}`;
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? activeDir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <TableHead aria-sort={ariaSort} className={className}>
      <Link
        href={href}
        className="hover:text-text-primary focus-visible:outline-border-focus inline-flex items-center focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {children}
        {isActive ? <SortArrow direction={activeDir} /> : null}
      </Link>
    </TableHead>
  );
}

interface PaginationProps {
  total: number;
  skip: number;
  take: number;
  searchParams: URLSearchParams;
}

function Pagination({ total, skip, take, searchParams }: PaginationProps): React.ReactElement {
  const safeTake = Math.max(take, 1);
  const pageCount = Math.max(1, Math.ceil(total / safeTake));
  const currentPage = Math.floor(skip / safeTake) + 1;
  const fromRow = total === 0 ? 0 : skip + 1;
  const toRow = Math.min(skip + safeTake, total);

  const pages: (number | "ellipsis")[] = [];
  if (pageCount <= 7) {
    for (let i = 1; i <= pageCount; i++) pages.push(i);
  } else {
    const window = new Set<number>([1, pageCount, currentPage - 1, currentPage, currentPage + 1]);
    let last = 0;
    for (let i = 1; i <= pageCount; i++) {
      if (window.has(i)) {
        if (i - last > 1) pages.push("ellipsis");
        pages.push(i);
        last = i;
      }
    }
  }

  const prevDisabled = currentPage <= 1;
  const nextDisabled = currentPage >= pageCount;
  const prevHref = `/service-schedules${paginationParams(searchParams, Math.max(0, skip - safeTake))}`;
  const nextHref = `/service-schedules${paginationParams(searchParams, skip + safeTake)}`;

  return (
    <nav
      aria-label="Pagination"
      className="border-border-subtle flex items-center justify-between border-t px-3 py-2 text-sm"
    >
      <p className="text-text-muted">
        {total === 0 ? "No results." : `Showing ${fromRow}–${toRow} of ${total}.`}
      </p>
      <div className="flex items-center gap-1">
        {prevDisabled ? (
          <Button variant="ghost" size="sm" disabled>
            Previous
          </Button>
        ) : (
          <Button asChild variant="ghost" size="sm">
            <Link href={prevHref} rel="prev">
              Previous
            </Link>
          </Button>
        )}
        {pages.map((p, idx) =>
          p === "ellipsis" ? (
            <span
              key={`ellipsis-${idx}`}
              aria-hidden="true"
              className="text-text-muted px-2 select-none"
            >
              …
            </span>
          ) : p === currentPage ? (
            <Button
              key={p}
              variant="outline"
              size="sm"
              aria-current="page"
              className="tabular-nums"
              disabled
            >
              {p}
            </Button>
          ) : (
            <Button key={p} asChild variant="ghost" size="sm" className="tabular-nums">
              <Link
                href={`/service-schedules${paginationParams(searchParams, (p - 1) * safeTake)}`}
              >
                {p}
              </Link>
            </Button>
          ),
        )}
        {nextDisabled ? (
          <Button variant="ghost" size="sm" disabled>
            Next
          </Button>
        ) : (
          <Button asChild variant="ghost" size="sm">
            <Link href={nextHref} rel="next">
              Next
            </Link>
          </Button>
        )}
      </div>
    </nav>
  );
}

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
            <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
              <Link href="/" className="hover:text-text-primary">
                FleetCo
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">Service schedules</span>
            </nav>
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
