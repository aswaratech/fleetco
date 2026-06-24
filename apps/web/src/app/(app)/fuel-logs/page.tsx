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
import { formatNpr } from "@/lib/money";
import { getServerSession } from "@/lib/session";
import { formatLiters } from "@/lib/units";

import { FuelLogsFilters } from "./fuel-logs-filters";
import type { FuelLogListItem } from "./types";

// Fuel logs list — Phase 1 vertical slice, iter 19 (read path). Server-
// rendered; reads the session cookie, redirects to /login if absent,
// fetches the list from the API (apps/api owns the auth handler per
// ADR-0021). Mirrors apps/web/src/app/jobs/page.tsx in shape:
//   - Filters: startDate / endDate (two date inputs in a client island);
//     the API also accepts vehicleId / tripId (cuid) which are set by
//     future deep-links from the Vehicle and Trip detail pages.
//   - Sort: clickable headers on the two whitelisted sortable columns
//     exposed here (date — the default — and createdAt). The schema's
//     `(date desc)` partial index makes the default cheap.
//   - Pagination: numbered page links; DEFAULT_PAGE_SIZE 20 matches the
//     API's LIST_TAKE_DEFAULT; "Showing M–N of T" per DESIGN.md §Tables.
//
// State all lives in URL searchParams — server-rendered, no client-side
// filtering. The only client island is `FuelLogsFilters`. No write
// path in iter 19: the header has no "Log fill" CTA and the empty
// state's "Log the first fill." copy is plain text (iter 20 wires it
// to /fuel-logs/new), per the kickoff.

type SortColumn = "date" | "createdAt";
type SortDir = "asc" | "desc";

interface FuelLogsListResponse {
  items: FuelLogListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

interface FuelLogsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function FuelLogsPage({
  searchParams,
}: FuelLogsPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const startDate = single(params.startDate);
  const endDate = single(params.endDate);
  const vehicleId = single(params.vehicleId);
  const tripId = single(params.tripId);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter =
    Boolean(startDate) || Boolean(endDate) || Boolean(vehicleId) || Boolean(tripId);

  // Forward only the params the API knows about; unknown query keys
  // would 400 (the schema is .strict()). skip/take defaults applied
  // here so every API request is explicit.
  const apiQuery = new URLSearchParams();
  if (startDate) apiQuery.set("startDate", startDate);
  if (endDate) apiQuery.set("endDate", endDate);
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);
  if (tripId) apiQuery.set("tripId", tripId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: FuelLogsListResponse;
  try {
    data = await apiFetch<FuelLogsListResponse>(`/api/v1/fuel-logs?${apiQuery.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // searchParams the in-page links operate on — mirror the URL's params,
  // not the API-mangled set (which always carries explicit skip/take).
  const urlSearchParams = new URLSearchParams();
  if (startDate) urlSearchParams.set("startDate", startDate);
  if (endDate) urlSearchParams.set("endDate", endDate);
  if (vehicleId) urlSearchParams.set("vehicleId", vehicleId);
  if (tripId) urlSearchParams.set("tripId", tripId);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Fuel logs" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Fuel logs</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No fuel logs match the current filters."
                  : "No fuel logs on file."
                : `${data.total} on file.`}
            </p>
          </div>
          {/* "Log fill" CTA (iter 20). Mirror of the Jobs / Customers
              / Drivers / Vehicles header CTA cluster. The new-fuel-log
              shell at /fuel-logs/new gates auth and pre-fetches the
              vehicle + trip pickers. */}
          <Button asChild>
            <Link href="/fuel-logs/new">Log fill</Link>
          </Button>
        </header>

        <FuelLogsFilters startDate={startDate} endDate={endDate} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No fuel logs match the current filters.</p>
              ) : (
                <p>
                  No fuel logs on file.{" "}
                  <Link
                    href="/fuel-logs/new"
                    className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                  >
                    Log the first fill.
                  </Link>
                </p>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader
                      basePath="/fuel-logs"
                      column="date"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Date
                    </SortableHeader>
                    <TableHead>Vehicle</TableHead>
                    <TableHead className="text-right tabular-nums">Liters</TableHead>
                    <TableHead className="text-right tabular-nums">Price / L</TableHead>
                    <TableHead className="text-right tabular-nums">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((f) => (
                    // Stretched-link pattern (matches the other list pages).
                    <TableRow key={f.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary tabular-nums">
                        <Link
                          href={`/fuel-logs/${f.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          <NepaliDate iso={f.date} format="bs" />
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary font-mono">
                        {f.vehicle.registrationNumber}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatLiters(f.litersMl)}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatNpr(f.pricePerLiterPaisa)}
                      </TableCell>
                      <TableCell className="text-text-primary text-right tabular-nums">
                        {formatNpr(f.totalCostPaisa)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/fuel-logs"
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
