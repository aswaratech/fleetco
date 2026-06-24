import Link from "next/link";
import { redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
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
import { worstComplianceState } from "@/lib/compliance";
import { getServerSession } from "@/lib/session";
import { VEHICLE_KIND_LABELS, VEHICLE_STATUS_LABELS } from "@/lib/vehicles-schema";

import type { Vehicle } from "./types";
import { VehiclesFilters } from "./vehicles-filters";

// Vehicle list — Phase 1 vertical slice. Server-rendered; reads the
// session cookie, redirects to /login if absent, and fetches the list
// from the API (apps/api owns the auth handler per ADR-0021).
//
// Iter 4 adds filter / sort / pagination:
//   - Filter: status and kind (single-value selects in the UI; the API
//     accepts comma-separated multi-value lists, so a future Combobox
//     can extend the surface without an API change). Filter state lives
//     in URL searchParams; the Select trigger is a client island.
//   - Sort: clickable column headers on the four whitelisted columns
//     (registrationNumber, acquiredAt, odometerCurrentKm; createdAt is
//     the default and is not exposed as a header because the page does
//     not render a createdAt column). Click toggles sortDir; clicking
//     a different column resets to that column with sortDir=desc per
//     the iter-4 spec.
//   - Pagination: numbered page links below the table. DEFAULT_PAGE_SIZE
//     is 20 (matches the API's DEFAULT_TAKE). "Showing M–N of T" copy
//     mirrors DESIGN.md §Tables's spec; prev/next disabled at edges.
//
// State all lives in URL searchParams — the page stays server-rendered,
// no client-side filtering. The only client island is `VehiclesFilters`
// (the shadcn Select needs interactive open/close state). Sortable
// headers and pagination controls are <Link>s so navigation flows
// through Next.js's router rather than onClick handlers.

// Sortable columns exposed in the UI. A subset of the API's whitelist
// (SORTABLE_COLUMNS in apps/api/src/modules/vehicles/vehicles.schemas.ts).
// Three of the four sortable API columns get header affordance here;
// `createdAt` is the default sort but has no rendered column, so users
// who want createdAt-asc clear the sort by removing the URL params
// (or by clicking another column twice). Both sides must stay in sync.
type SortColumn = "registrationNumber" | "odometerCurrentKm" | "acquiredAt" | "createdAt";
type SortDir = "asc" | "desc";

// The API echoes the effective sort + pagination + total back so the
// UI renders from the same authoritative numbers that ran the query
// (rather than re-deriving from URL params — a typo'd URL would
// otherwise corrupt the active-column indicator).
interface VehiclesListResponse {
  items: Vehicle[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

function formatKilometers(km: number): string {
  // DESIGN.md §Data display "Distance": Latin numerals, kilometers, one
  // decimal place. Matches the detail page's formatter.
  const formatter = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatter.format(km)} km`;
}

// Worst-of-three compliance roll-up cell — the sanctioned vehicles-list column
// (ADR-0031 §E / "Revisit when": "add the worst-of-three indicator column to
// vehicles/page.tsx, reusing complianceBadgeState"). `worstComplianceState`
// classifies the vehicle's three document expiries (bluebook / insurance /
// route permit) against now and returns the MOST URGENT state; we paint the
// same red "Expired" / amber "Expiring soon" <Badge> the Vehicle detail
// Compliance section uses, and render a quiet em-dash when every document is
// current ("ok") or unscanned ("none") so a compliant fleet reads as a calm
// column rather than a wall of chips. Read-only — this column is NOT in the
// sort whitelist (worst-of-three is a derived value, not a server-sortable
// scalar column).
function ComplianceRollUp({ vehicle }: { vehicle: Vehicle }): React.ReactElement {
  const state = worstComplianceState(
    [vehicle.bluebookExpiresAt, vehicle.insuranceExpiresAt, vehicle.routePermitExpiresAt],
    new Date(),
  );
  if (state === "expired") return <Badge variant="error">Expired</Badge>;
  if (state === "expiring-soon") return <Badge variant="warning">Expiring soon</Badge>;
  return <>—</>;
}

// Next.js 15: searchParams arrives as a Promise per the App Router's
// async-params convention (the same shape /vehicles/[id] uses).
interface VehiclesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Normalize a single search-param value: if Next.js gives us an array
// (a key repeated in the URL like `?status=ACTIVE&status=SOLD`), take
// the first occurrence. The API accepts comma-separated values in a
// single key — repeated keys are a URL shape we tolerate by collapsing
// to the first.
function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function VehiclesPage({
  searchParams,
}: VehiclesPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const kind = single(params.kind);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  // Distinguish "filter is in effect" from "no filter active". The
  // empty-state copy and CTA both branch on this; see the section
  // body below. Sort and pagination state are NOT considered filters
  // for the purposes of this branch — sorting an empty result is the
  // same surface as sorting a non-empty one, and "no rows match the
  // current sort" makes no semantic sense.
  const hasActiveFilter = Boolean(status) || Boolean(kind);

  // Forward the user's params to the API. We pass through only the
  // params the API knows about; unknown query keys would 400 (the
  // schema is .strict()). `skip` / `take` defaults are applied here so
  // every API request is explicit.
  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (kind) apiQuery.set("kind", kind);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: VehiclesListResponse;
  try {
    data = await apiFetch<VehiclesListResponse>(`/api/v1/vehicles?${apiQuery.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // Build the searchParams object the in-page links (sort headers,
  // pagination buttons) operate on. We mirror the URL's params, not
  // the API-mangled set, because navigation should preserve the
  // user-visible URL shape rather than rewrite to the canonical form.
  const urlSearchParams = new URLSearchParams();
  if (status) urlSearchParams.set("status", status);
  if (kind) urlSearchParams.set("kind", kind);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Vehicles" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Vehicles</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No vehicles match the current filters."
                  : "No vehicles registered."
                : `${data.total} registered.`}
            </p>
          </div>
          {/* Primary action right-aligned per DESIGN.md §"Page header".
              `asChild` lets the Button render as a Next.js <Link>, which
              gets us client-side navigation without a wrapping <a>. */}
          <Button asChild>
            <Link href="/vehicles/new">New vehicle</Link>
          </Button>
        </header>

        <VehiclesFilters status={status} kind={kind} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            // Two empty-state copy variants per DESIGN.md voice. The
            // "no vehicles at all" path repeats the CTA inline so the
            // user doesn't have to look up at the header to take the
            // expected next step.
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No vehicles match the current filters.</p>
              ) : (
                <>
                  <p>No vehicles registered.</p>
                  <p>
                    <Link
                      href="/vehicles/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Register the first vehicle.
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
                      basePath="/vehicles"
                      column="registrationNumber"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Registration
                    </SortableHeader>
                    <TableHead>Kind</TableHead>
                    <TableHead>Make / Model</TableHead>
                    <SortableHeader
                      basePath="/vehicles"
                      column="acquiredAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Acquired
                    </SortableHeader>
                    <TableHead>Status</TableHead>
                    {/* Compliance roll-up (worst of bluebook / insurance /
                        route-permit expiry). Read-only — not a SortableHeader,
                        because worst-of-three is a derived value with no
                        server-side sort column. */}
                    <TableHead>Compliance</TableHead>
                    <SortableHeader
                      basePath="/vehicles"
                      column="odometerCurrentKm"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Odometer
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((v) => (
                    // Stretched-link pattern: the row is `relative`, the
                    // first cell hosts a Link with `before:absolute
                    // before:inset-0` so the whole row reads as one
                    // clickable surface while preserving valid table
                    // HTML and a single tab stop per row. (Iter 3.)
                    <TableRow key={v.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary font-mono">
                        <Link
                          href={`/vehicles/${v.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {v.registrationNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {VEHICLE_KIND_LABELS[v.kind] ?? v.kind}
                      </TableCell>
                      <TableCell className="text-text-primary">
                        {v.make} {v.model}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={v.acquiredAt} format="bs" />
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {VEHICLE_STATUS_LABELS[v.status] ?? v.status}
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        <ComplianceRollUp vehicle={v} />
                      </TableCell>
                      <TableCell className="text-text-primary text-right tabular-nums">
                        {formatKilometers(v.odometerCurrentKm)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/vehicles"
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
