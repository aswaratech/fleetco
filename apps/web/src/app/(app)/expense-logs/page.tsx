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

import { ExpenseLogsFilters } from "./expense-logs-filters";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory, type ExpenseLogListItem } from "./types";

// Expense logs list — Phase 1 vertical slice, iter 21 (read path).
// Server-rendered; reads the session cookie, redirects to /login if
// absent, fetches the list from the API (apps/api owns the auth
// handler per ADR-0021). Mirrors apps/web/src/app/fuel-logs/page.tsx
// in shape:
//   - Filters: category (eight-value enum select), startDate / endDate
//     (two date inputs in a client island); the API also accepts
//     vehicleId / tripId (cuid) which are set by future deep-links
//     from the Vehicle and Trip detail pages.
//   - Sort: clickable headers on the three whitelisted sortable
//     columns exposed here (date — the default — , amountPaisa, and
//     createdAt). The schema's `(date desc)` partial index makes the
//     default cheap; amountPaisa is sortable so the per-vehicle cost
//     report can surface "biggest expense first" without a dedicated
//     reports route this iter.
//   - Pagination: numbered page links; DEFAULT_PAGE_SIZE 20 matches
//     the API's LIST_TAKE_DEFAULT; "Showing M–N of T" per DESIGN.md
//     §Tables.
//
// State all lives in URL searchParams — server-rendered, no client-
// side filtering. The only client island is `ExpenseLogsFilters`. No
// write path in iter 21: the header has no "Log expense" CTA and the
// empty state's "Log the first one." copy is plain text (iter 22
// wires it to /expense-logs/new), per the kickoff.
//
// The vehicle column renders an em-dash for vehicle-agnostic expenses
// (vehicleId IS NULL), reflecting the schema's nullable FK. The trip
// column similarly em-dashes when there's no trip linkage.

type SortColumn = "date" | "amountPaisa" | "createdAt";
type SortDir = "asc" | "desc";

interface ExpenseLogsListResponse {
  items: ExpenseLogListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

interface ExpenseLogsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function ExpenseLogsPage({
  searchParams,
}: ExpenseLogsPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const category = single(params.category);
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
    Boolean(category) ||
    Boolean(startDate) ||
    Boolean(endDate) ||
    Boolean(vehicleId) ||
    Boolean(tripId);

  // Forward only the params the API knows about; unknown query keys
  // would 400 (the schema is .strict()). skip/take defaults applied
  // here so every API request is explicit.
  const apiQuery = new URLSearchParams();
  if (category) apiQuery.set("category", category);
  if (startDate) apiQuery.set("startDate", startDate);
  if (endDate) apiQuery.set("endDate", endDate);
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);
  if (tripId) apiQuery.set("tripId", tripId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: ExpenseLogsListResponse;
  try {
    data = await apiFetch<ExpenseLogsListResponse>(`/api/v1/expense-logs?${apiQuery.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // searchParams the in-page links operate on — mirror the URL's
  // params, not the API-mangled set (which always carries explicit
  // skip/take).
  const urlSearchParams = new URLSearchParams();
  if (category) urlSearchParams.set("category", category);
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
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Expense logs" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Expense logs</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No expenses match the current filters."
                  : "No expenses on file."
                : `${data.total} on file.`}
            </p>
          </div>
          {/* "New expense" CTA (iter 22). Mirror of the Fuel logs /
              Jobs / Customers / Drivers / Vehicles header CTA
              cluster. The new-expense-log shell at /expense-logs/new
              gates auth and pre-fetches the vehicle + trip pickers
              (vehicle is optional — vehicle-agnostic expenses are a
              first-class shape). */}
          <Button asChild>
            <Link href="/expense-logs/new">New expense</Link>
          </Button>
        </header>

        <ExpenseLogsFilters startDate={startDate} endDate={endDate} category={category} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No expenses match the current filters.</p>
              ) : (
                <p>
                  No expenses on file.{" "}
                  <Link
                    href="/expense-logs/new"
                    className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                  >
                    Log the first one.
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
                      basePath="/expense-logs"
                      column="date"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Date
                    </SortableHeader>
                    <TableHead>Vehicle</TableHead>
                    <TableHead>Trip</TableHead>
                    <TableHead>Category</TableHead>
                    <SortableHeader
                      basePath="/expense-logs"
                      column="amountPaisa"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Amount
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((e) => (
                    // Stretched-link pattern (matches the other list pages).
                    <TableRow key={e.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary tabular-nums">
                        <Link
                          href={`/expense-logs/${e.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          <NepaliDate iso={e.date} format="bs" />
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary font-mono">
                        {e.vehicle ? e.vehicle.registrationNumber : "—"}
                      </TableCell>
                      <TableCell className="text-text-secondary font-mono">
                        {e.trip ? e.trip.id.slice(-8) : "—"}
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {EXPENSE_CATEGORY_LABELS[e.category as ExpenseCategory] ?? e.category}
                      </TableCell>
                      <TableCell className="text-text-primary text-right tabular-nums">
                        {formatNpr(e.amountPaisa)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/expense-logs"
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
