import Link from "next/link";
import { redirect } from "next/navigation";

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

import { TripsFilters } from "./trips-filters";
import { TRIP_STATUS_LABELS, type TripListItem, type TripStatus } from "./types";

// Trips list — Phase 1 vertical slice, iter 8. Server-rendered; reads
// the session cookie, redirects to /login if absent, and fetches the
// list from the API (apps/api owns the auth handler per ADR-0021).
//
// Mirrors apps/web/src/app/drivers/page.tsx in shape:
//   - Filter: status (single-value select; the API accepts a comma-
//     separated multi-value list but the UI is single-value for now).
//   - Sort: clickable column headers on the three whitelisted columns
//     (startedAt, endedAt; createdAt is the default and is not exposed
//     as a header because the page does not render a createdAt
//     column). Click toggles sortDir; clicking a different column
//     resets to that column with sortDir=desc.
//   - Pagination: numbered page links below the table. DEFAULT_PAGE_SIZE
//     is 20 (matches the API's LIST_TAKE_DEFAULT). "Showing M–N of T"
//     mirrors DESIGN.md §Tables's spec; prev/next disabled at edges.
//
// State all lives in URL searchParams — the page stays server-rendered,
// no client-side filtering. The only client island is `TripsFilters`
// (the shadcn Select needs interactive open/close state). Sortable
// headers and pagination controls are <Link>s so navigation flows
// through Next.js's router rather than onClick handlers.
//
// `vehicleId` and `driverId` URL params (set by a future "Trips for
// this vehicle" link on Vehicle detail) are forwarded to the API
// without being surfaced in the filter toolbar — the page narrows
// transparently and the breadcrumb describes the scope.
//
// No write path in iter 8. The header lacks the "New trip" CTA that
// the iter-9 write path adds (matches Drivers iter-6 → iter-7
// staging).

// Sortable columns exposed in the UI. A subset of the API's whitelist
// (SORTABLE_COLUMNS in apps/api/src/modules/trips/trips.schemas.ts).
// Two of the three sortable API columns get header affordance here;
// `createdAt` is the default sort but has no rendered column.
type SortColumn = "startedAt" | "endedAt" | "createdAt";
type SortDir = "asc" | "desc";

// The API echoes the effective sort + pagination + total back so the
// UI renders from the same authoritative numbers that ran the query.
interface TripsListResponse {
  items: TripListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

interface TripsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

// Render an ISO date+time as YYYY-MM-DD HH:MM UTC (no seconds — the
// trip aggregate's timestamps are minute-precision in practice). For
// dates only (e.g., a planned trip with no startedAt) we render "—".
// Matches the Drivers list page's formatDate spirit; BS-calendar
// rendering arrives with the future <NepaliDate> component per
// DESIGN.md §"BS calendar".
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

export default async function TripsPage({
  searchParams,
}: TripsPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const vehicleId = single(params.vehicleId);
  const driverId = single(params.driverId);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(status) || Boolean(vehicleId) || Boolean(driverId);

  // Forward the user's params to the API. We pass through only the
  // params the API knows about; unknown query keys would 400 (the
  // schema is .strict()). `skip` / `take` defaults are applied here so
  // every API request is explicit.
  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);
  if (driverId) apiQuery.set("driverId", driverId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: TripsListResponse;
  try {
    data = await apiFetch<TripsListResponse>(`/api/v1/trips?${apiQuery.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // Build the searchParams object the in-page links (sort headers,
  // pagination buttons) operate on. We mirror the URL's params, not
  // the API-mangled set.
  const urlSearchParams = new URLSearchParams();
  if (status) urlSearchParams.set("status", status);
  if (vehicleId) urlSearchParams.set("vehicleId", vehicleId);
  if (driverId) urlSearchParams.set("driverId", driverId);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Trips" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Trips</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No trips match the current filters."
                  : "No trips recorded."
                : `${data.total} recorded.`}
            </p>
          </div>
          {/* Primary action right-aligned per DESIGN.md §"Page header".
              Iter 9 wired the "New trip" CTA up to the write path. */}
          <Button asChild>
            <Link href="/trips/new">New trip</Link>
          </Button>
        </header>

        <TripsFilters status={status} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No trips match the current filters.</p>
              ) : (
                <>
                  <p>No trips recorded yet.</p>
                  <p>
                    <Link
                      href="/trips/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Plan or record the first trip.
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
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Status</TableHead>
                    <SortableHeader
                      basePath="/trips"
                      column="startedAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Started
                    </SortableHeader>
                    <SortableHeader
                      basePath="/trips"
                      column="endedAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Ended
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((t) => (
                    // Stretched-link pattern (matches Drivers / Vehicles
                    // list).
                    <TableRow key={t.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary font-mono">
                        <Link
                          href={`/trips/${t.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {t.vehicle.registrationNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">{t.driver.fullName}</TableCell>
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
              <Pagination
                basePath="/trips"
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
