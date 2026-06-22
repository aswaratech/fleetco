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
import { DRIVER_STATUS_LABELS, LICENSE_CLASS_LABELS } from "@/lib/drivers-schema";
import { getServerSession } from "@/lib/session";

import { DriversFilters } from "./drivers-filters";
import type { Driver } from "./types";

// Driver list — Phase 1 vertical slice, iter 6. Server-rendered; reads
// the session cookie, redirects to /login if absent, and fetches the
// list from the API (apps/api owns the auth handler per ADR-0021).
//
// Mirrors apps/web/src/app/vehicles/page.tsx in shape:
//   - Filter: status and licenseClass (single-value selects in the UI;
//     the API accepts comma-separated multi-value lists).
//   - Sort: clickable column headers on the four whitelisted columns
//     (fullName, hiredAt, licenseExpiresAt; createdAt is the default
//     and is not exposed as a header because the page does not render
//     a createdAt column). Click toggles sortDir; clicking a different
//     column resets to that column with sortDir=desc.
//   - Pagination: numbered page links below the table. DEFAULT_PAGE_SIZE
//     is 20 (matches the API's LIST_TAKE_DEFAULT). "Showing M–N of T"
//     mirrors DESIGN.md §Tables's spec; prev/next disabled at edges.
//
// State all lives in URL searchParams — the page stays server-rendered,
// no client-side filtering. The only client island is `DriversFilters`
// (the shadcn Select needs interactive open/close state). Sortable
// headers and pagination controls are <Link>s so navigation flows
// through Next.js's router rather than onClick handlers.
//
// No write path in iter 6. The header lacks the "New driver" CTA that
// the Vehicles page has — that lands in iter 7 alongside the create form.

// Sortable columns exposed in the UI. A subset of the API's whitelist
// (SORTABLE_COLUMNS in apps/api/src/modules/drivers/drivers.schemas.ts).
// Three of the four sortable API columns get header affordance here;
// `createdAt` is the default sort but has no rendered column.
type SortColumn = "fullName" | "hiredAt" | "licenseExpiresAt" | "createdAt";
type SortDir = "asc" | "desc";

// The API echoes the effective sort + pagination + total back so the
// UI renders from the same authoritative numbers that ran the query.
interface DriversListResponse {
  items: Driver[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

// Build the link for a pagination control. Filter and sort values are
// preserved; only `skip` changes. When skip is zero we omit the key
// entirely so the canonical /drivers URL stays clean.
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

// Build the link for a sortable column header. If the column is the
// active sort, clicking toggles sortDir. If it is a different column,
// clicking sets that column with sortDir=desc. Same convention as the
// Vehicles list page.
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

// Inline arrow icon for the active-sort indicator. Same SVG as the
// Vehicles list page; promoting to a shared component is deferred
// until the third list surface (Customers, Phase 1) lands.
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
  const href = `/drivers${sortParams(searchParams, column, activeColumn, activeDir)}`;
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
  const prevHref = `/drivers${paginationParams(searchParams, Math.max(0, skip - safeTake))}`;
  const nextHref = `/drivers${paginationParams(searchParams, skip + safeTake)}`;

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
              <Link href={`/drivers${paginationParams(searchParams, (p - 1) * safeTake)}`}>
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

// Next.js 15: searchParams arrives as a Promise per the App Router's
// async-params convention (the same shape /vehicles/[id] uses).
interface DriversPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function DriversPage({
  searchParams,
}: DriversPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const licenseClass = single(params.licenseClass);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(status) || Boolean(licenseClass);

  // Forward the user's params to the API. We pass through only the
  // params the API knows about; unknown query keys would 400 (the
  // schema is .strict()). `skip` / `take` defaults are applied here so
  // every API request is explicit.
  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (licenseClass) apiQuery.set("licenseClass", licenseClass);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: DriversListResponse;
  try {
    data = await apiFetch<DriversListResponse>(`/api/v1/drivers?${apiQuery.toString()}`);
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
  if (licenseClass) urlSearchParams.set("licenseClass", licenseClass);
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
              <span className="text-text-secondary">Drivers</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">Drivers</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No drivers match the current filters."
                  : "No drivers registered."
                : `${data.total} registered.`}
            </p>
          </div>
          {/* Primary action right-aligned per DESIGN.md §"Page header".
              `asChild` lets the Button render as a Next.js <Link>, which
              gets us client-side navigation without a wrapping <a>.
              Iter 7 wired the "New driver" CTA up to the write path. */}
          <Button asChild>
            <Link href="/drivers/new">New driver</Link>
          </Button>
        </header>

        <DriversFilters status={status} licenseClass={licenseClass} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            // Two empty-state copy variants per DESIGN.md voice. The
            // "no drivers at all" path repeats the CTA inline so the
            // user doesn't have to look up at the header to take the
            // expected next step. Mirrors the Vehicles list empty state.
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No drivers match the current filters.</p>
              ) : (
                <>
                  <p>No drivers registered.</p>
                  <p>
                    <Link
                      href="/drivers/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Register the first driver.
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
                      column="fullName"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Name
                    </SortableHeader>
                    <TableHead>License</TableHead>
                    <TableHead>Class</TableHead>
                    <TableHead>Status</TableHead>
                    <SortableHeader
                      column="hiredAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Hired
                    </SortableHeader>
                    <SortableHeader
                      column="licenseExpiresAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      License expires
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((d) => (
                    // Stretched-link pattern (matches Vehicles list).
                    <TableRow key={d.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary">
                        <Link
                          href={`/drivers/${d.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {d.fullName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary font-mono">
                        {d.licenseNumber}
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {LICENSE_CLASS_LABELS[d.licenseClass] ?? d.licenseClass}
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {DRIVER_STATUS_LABELS[d.status] ?? d.status}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={d.hiredAt} format="bs" />
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={d.licenseExpiresAt} format="bs" />
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
