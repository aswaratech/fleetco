import Link from "next/link";
import { redirect } from "next/navigation";

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
import { GEOFENCE_TYPE_LABELS } from "@/lib/geofences-schema";
import { getServerSession } from "@/lib/session";

import { GeofencesFilters } from "./geofences-filters";
import type { Geofence } from "./types";

// Geofence list — ADR-0030 G3 (web admin CRUD scaffold). Server-rendered;
// reads the session cookie, redirects to /login if absent, and fetches the
// list from the API (apps/api owns the auth handler per ADR-0021; the
// `geofences:read` capability is ADMIN + OFFICE_STAFF — the API enforces
// it, the web app does no extra role-gating, mirroring the other
// aggregates).
//
// Mirrors apps/web/src/app/customers/page.tsx in shape:
//   - Filter: type (single-value select in the UI; the API accepts the
//     comma-separated multi-value list). A `customerId` URL param is
//     forwarded to the API but not surfaced in the toolbar — same as the
//     Jobs list, so a future "geofences for this customer" deep-link works
//     without a new control.
//   - Sort: clickable headers on the three whitelisted sortable columns
//     (name, type, createdAt). Click toggles sortDir; a different column
//     resets to that column desc.
//   - Pagination: numbered page links; DEFAULT_PAGE_SIZE 20 matches the
//     API's LIST_TAKE_DEFAULT; "Showing M–N of T" per DESIGN.md §Tables.
//
// CUSTOMER NAME RESOLUTION: the geofence list response carries only
// `customerId` (it does not nest the Customer). The owning customer name
// for CUSTOMER_SITE rows is resolved by fetching the customers list ONCE
// (take=200, alphabetical) and mapping id → name — cheaper than a per-row
// fetch for a sub-hundred-customer Phase-1 fleet. A customerId not in the
// first 200 (or a failed enrichment fetch) falls back to the raw id, so
// the list always renders.

type SortColumn = "name" | "type" | "createdAt";
type SortDir = "asc" | "desc";

// The API echoes the effective sort + pagination + total back so the UI
// renders from the same authoritative numbers that ran the query.
interface GeofencesListResponse {
  items: Geofence[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

// Slim Customer projection sufficient for the id → name map.
interface CustomerOption {
  id: string;
  name: string;
}

interface CustomersListResponse {
  items: CustomerOption[];
  total: number;
  skip: number;
  take: number;
}

const DEFAULT_PAGE_SIZE = 20;

// Build the link for a pagination control. Filter and sort values are
// preserved; only `skip` changes. Omit the key at page 0 so the canonical
// /geofences URL stays clean.
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

// Build the link for a sortable column header. Toggles dir on the active
// column, else sets the new column desc. Same convention as the other list
// pages.
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
  const href = `/geofences${sortParams(searchParams, column, activeColumn, activeDir)}`;
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
  const prevHref = `/geofences${paginationParams(searchParams, Math.max(0, skip - safeTake))}`;
  const nextHref = `/geofences${paginationParams(searchParams, skip + safeTake)}`;

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
              <Link href={`/geofences${paginationParams(searchParams, (p - 1) * safeTake)}`}>
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

interface GeofencesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

// Render a date as YYYY-MM-DD. Matches the other list-page formatters;
// BS-calendar rendering arrives with the future <NepaliDate> component.
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default async function GeofencesPage({
  searchParams,
}: GeofencesPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const type = single(params.type);
  const customerId = single(params.customerId);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(type) || Boolean(customerId);

  // Forward only the params the API knows about; unknown query keys would
  // 400 (the schema is .strict()). skip/take defaults applied here so every
  // API request is explicit.
  const apiQuery = new URLSearchParams();
  if (type) apiQuery.set("type", type);
  if (customerId) apiQuery.set("customerId", customerId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: GeofencesListResponse;
  try {
    data = await apiFetch<GeofencesListResponse>(`/api/v1/geofences?${apiQuery.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // Resolve owning-customer names for CUSTOMER_SITE rows. Fetch the
  // customers list once and map id → name. A 401 redirects (the session
  // expired between the two fetches); any other failure degrades to the
  // raw id rather than failing the whole page, since the primary list
  // already loaded.
  const customerNames = new Map<string, string>();
  const needsCustomerNames = data.items.some((g) => g.customerId !== null);
  if (needsCustomerNames) {
    try {
      const customers = await apiFetch<CustomersListResponse>(
        "/api/v1/customers?sortBy=name&sortDir=asc&take=200",
      );
      for (const c of customers.items) {
        customerNames.set(c.id, c.name);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirect("/login");
      }
      // Non-401: leave the map empty; rows fall back to the raw id below.
    }
  }

  // searchParams the in-page links operate on — mirror the URL's params,
  // not the API-mangled set (which always carries explicit skip/take).
  const urlSearchParams = new URLSearchParams();
  if (type) urlSearchParams.set("type", type);
  if (customerId) urlSearchParams.set("customerId", customerId);
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
              <span className="text-text-secondary">Geofences</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">Geofences</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No geofences match the current filters."
                  : "No geofences defined."
                : `${data.total} defined.`}
            </p>
          </div>
          <Button asChild>
            <Link href="/geofences/new">New geofence</Link>
          </Button>
        </header>

        <GeofencesFilters type={type} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No geofences match the current filters.</p>
              ) : (
                <>
                  <p>No geofences defined.</p>
                  <p>
                    <Link
                      href="/geofences/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Define the first geofence.
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
                    <SortableHeader
                      column="type"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Type
                    </SortableHeader>
                    <TableHead>Customer</TableHead>
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
                  {data.items.map((g) => (
                    // Stretched-link pattern (matches the other list pages).
                    <TableRow key={g.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary">
                        <Link
                          href={`/geofences/${g.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {g.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {GEOFENCE_TYPE_LABELS[g.type] ?? g.type}
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {g.customerId === null
                          ? "—"
                          : (customerNames.get(g.customerId) ?? g.customerId)}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatDate(g.createdAt)}
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
