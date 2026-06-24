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
import { CUSTOMER_STATUS_LABELS } from "@/lib/customers-schema";
import { getServerSession } from "@/lib/session";

import { CustomersFilters } from "./customers-filters";
import type { Customer } from "./types";

// Customer list — Phase 1 vertical slice, iter 15. Server-rendered;
// reads the session cookie, redirects to /login if absent, and fetches
// the list from the API (apps/api owns the auth handler per ADR-0021).
//
// Mirrors apps/web/src/app/drivers/page.tsx in shape:
//   - Filter: status (single-value select in the UI; the API accepts
//     comma-separated multi-value lists).
//   - Sort: clickable column headers on the two whitelisted sortable
//     columns (name; createdAt is the default and is not exposed as a
//     header because the page does not render a createdAt column).
//     Click toggles sortDir; clicking a different column resets to
//     that column with sortDir=desc.
//   - Pagination: numbered page links below the table. DEFAULT_PAGE_SIZE
//     is 20 (matches the API's LIST_TAKE_DEFAULT). "Showing M–N of T"
//     mirrors DESIGN.md §Tables's spec; prev/next disabled at edges.
//
// State all lives in URL searchParams — the page stays server-rendered,
// no client-side filtering. The only client island is `CustomersFilters`
// (the shadcn Select needs interactive open/close state). Sortable
// headers and pagination controls are <Link>s so navigation flows
// through Next.js's router rather than onClick handlers.
//
// Iter 16 wires the "New customer" CTA and the empty-state "Register
// the first customer." link up to the write path; the create form
// lives at /customers/new (../new/page.tsx) and posts via the
// createCustomerAction server action.

// Sortable columns exposed in the UI. A subset of the API's whitelist
// (SORTABLE_COLUMNS in apps/api/src/modules/customers/customers.schemas.ts).
// Only `name` gets a header affordance here; `createdAt` is the default
// sort but has no rendered column (the list renders a "Created" column
// that displays the date, but the iter scopes the affordance to `name`
// to keep the surface minimal — Drivers does the same with createdAt).
type SortColumn = "name" | "createdAt";
type SortDir = "asc" | "desc";

// The API echoes the effective sort + pagination + total back so the
// UI renders from the same authoritative numbers that ran the query.
interface CustomersListResponse {
  items: Customer[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

// Next.js 15: searchParams arrives as a Promise per the App Router's
// async-params convention (the same shape /drivers and /vehicles use).
interface CustomersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function CustomersPage({
  searchParams,
}: CustomersPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(status);

  // Forward the user's params to the API. We pass through only the
  // params the API knows about; unknown query keys would 400 (the
  // schema is .strict()). `skip` / `take` defaults are applied here
  // so every API request is explicit.
  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: CustomersListResponse;
  try {
    data = await apiFetch<CustomersListResponse>(`/api/v1/customers?${apiQuery.toString()}`);
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
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Customers" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Customers</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No customers match the current filters."
                  : "No customers registered."
                : `${data.total} registered.`}
            </p>
          </div>
          {/* Primary action right-aligned per DESIGN.md §"Page header".
              `asChild` lets the Button render as a Next.js <Link>, which
              gets us client-side navigation without a wrapping <a>.
              Iter 16 wired the "New customer" CTA up to the write path
              (mirror of the Drivers iter-7 CTA). */}
          <Button asChild>
            <Link href="/customers/new">New customer</Link>
          </Button>
        </header>

        <CustomersFilters status={status} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            // Two empty-state copy variants per DESIGN.md voice. The
            // "no customers at all" path repeats the CTA inline so the
            // user doesn't have to look up at the header to take the
            // expected next step. Mirrors the Drivers / Vehicles list
            // empty states (iter 16 lift, same as the Drivers iter-7
            // swap-in).
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No customers match the current filters.</p>
              ) : (
                <>
                  <p>No customers registered.</p>
                  <p>
                    <Link
                      href="/customers/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Register the first customer.
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
                      basePath="/customers"
                      column="name"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Name
                    </SortableHeader>
                    <TableHead>Contact</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Status</TableHead>
                    <SortableHeader
                      basePath="/customers"
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
                  {data.items.map((c) => (
                    // Stretched-link pattern (matches Drivers / Vehicles
                    // list pages).
                    <TableRow key={c.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary">
                        <Link
                          href={`/customers/${c.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {c.name}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {c.contactPerson ?? "—"}
                      </TableCell>
                      <TableCell className="text-text-secondary font-mono">{c.phone}</TableCell>
                      <TableCell className="text-text-secondary">
                        {CUSTOMER_STATUS_LABELS[c.status] ?? c.status}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={c.createdAt} format="bs" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/customers"
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
