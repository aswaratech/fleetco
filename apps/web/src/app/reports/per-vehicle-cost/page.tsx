import Link from "next/link";
import { redirect } from "next/navigation";

import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, ApiError } from "@/lib/api";
import { formatNpr } from "@/lib/money";
import { formatNepaliDate } from "@/lib/nepali-date";
import { getServerSession } from "@/lib/session";

import { PerVehicleCostFilters } from "./per-vehicle-cost-filters";
import type { PerVehicleCostReport, PerVehicleCostRow } from "./types";

// Per-vehicle cost report — Phase 1 vertical slice, iter 23 (Reports
// v1, the last Phase-1 slice). Server-rendered; reads the session
// cookie, redirects to /login if absent, fetches the report from the
// API (apps/api owns the auth handler per ADR-0021). Mirrors apps/
// web/src/app/expense-logs/page.tsx in shape:
//
//   - Filters: from / to (two date inputs in a client island), with
//     a default window of the current calendar month UTC; an
//     optional vehicleId picker (single-vehicle narrow). State lives
//     in URL searchParams.
//   - Table: vehicle registration (links to /vehicles/<id>), fuel
//     paisa, expense paisa, total paisa, fuel-log count, expense-log
//     count. Sorted server-side by totalPaisa desc (the API echoes
//     the sort; we don't re-sort client-side).
//   - Totals row: per-column sums across the rows array. A
//     "Company-level (not vehicle-attributable)" sub-row appears
//     beneath the totals when the companyLevel block is non-zero
//     — vehicle-agnostic expenses are deliberately separate from
//     per-vehicle totals so the operator can see both without the
//     two getting confused.
//
// The vehicle picker is populated from a server-side pre-fetch of
// the vehicles list (the schema's .strict() flag would reject a
// loose `vehicleId` value, so a free-form input would be a footgun;
// a typed picker is the affordance). Inactive vehicles are still
// included in the picker because a historical date range may still
// surface their costs; the picker labels them by registration
// number alone.
//
// Three iter-22 rules carry through from Expense logs:
//   1. amountPaisa is summed verbatim (no derivation).
//   2. Vehicle-agnostic expenses (vehicleId=null) go into
//      companyLevel, never into a per-vehicle row.
//   3. The date filter applies to the `date` column on both FuelLog
//      and ExpenseLog (the user's reporting date), not createdAt.
//
// Sort is fixed server-side at totalPaisa desc with
// registrationNumber tiebreaker; the table does not surface
// sortable headers because the slice's wire contract doesn't
// support arbitrary sorts on this surface (and the operator's eye
// for "where's the cost going" wants totalPaisa-desc by default).
// A future iter that wants a different sort can widen the API.

// Vehicles list response shape — see apps/api/src/modules/vehicles/
// vehicles.controller.ts. We only need the id + registrationNumber
// pair for the picker; the rest of the projection is ignored.
interface VehiclePickerItem {
  id: string;
  registrationNumber: string;
}

interface VehiclesListResponse {
  items: VehiclePickerItem[];
}

// Compute the current calendar month UTC as a [from, to] pair. The
// helper is exported as a const-like to keep the page body
// readable; both ends are YYYY-MM-DD strings the API parses.
function defaultDateRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const fromDate = new Date(Date.UTC(y, m, 1));
  // Last day of the month: day 0 of the next month is the last day
  // of the current month in UTC.
  const toDate = new Date(Date.UTC(y, m + 1, 0));
  const fmt = (d: Date): string => {
    const yy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  };
  return { from: fmt(fromDate), to: fmt(toDate) };
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

interface PerVehicleCostPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PerVehicleCostPage({
  searchParams,
}: PerVehicleCostPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const defaults = defaultDateRange();
  const from = single(params.from) ?? defaults.from;
  const to = single(params.to) ?? defaults.to;
  const vehicleId = single(params.vehicleId) ?? "";

  // Build the API query. The schema is .strict() so we forward only
  // the keys it knows about.
  const apiQuery = new URLSearchParams();
  apiQuery.set("from", from);
  apiQuery.set("to", to);
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);

  // Pre-fetch both the report and the vehicle picker's options in
  // parallel. The picker query asks for a wide take (200 — the
  // API's LIST_TAKE_MAX) so the operator usually sees every vehicle
  // in a single dropdown without paging. A future Phase-1 fleet
  // would outgrow this and want a typeahead combobox; the API's
  // pagination already supports it.
  let report: PerVehicleCostReport;
  let vehicles: VehiclesListResponse;
  try {
    [report, vehicles] = await Promise.all([
      apiFetch<PerVehicleCostReport>(`/api/v1/reports/per-vehicle-cost?${apiQuery.toString()}`),
      apiFetch<VehiclesListResponse>(
        `/api/v1/vehicles?take=200&sortBy=registrationNumber&sortDir=asc`,
      ),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const hasCompanyLevel = report.companyLevel.expenseLogCount > 0;
  const hasAnyRows = report.rows.length > 0;

  // BS-render the report window for the subtitle (ADR-0031 N2 — "reports"
  // is in commitment 4's BS-display scope). The `bs` variant keeps the
  // sentence compact; the AD window stays visible in the date *inputs*
  // (PerVehicleCostFilters), which remain native AD per commitment 6.
  const fromBs = formatNepaliDate(report.from, { format: "bs" });
  const toBs = formatNepaliDate(report.to, { format: "bs" });

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Per-vehicle cost report</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Per-vehicle cost report</h1>
          <p className="text-text-muted text-sm">
            {hasAnyRows
              ? `${report.rows.length} vehicle${report.rows.length === 1 ? "" : "s"} with activity from ${fromBs} to ${toBs}.`
              : `No vehicle activity from ${fromBs} to ${toBs}.`}
          </p>
        </header>

        <PerVehicleCostFilters
          from={from}
          to={to}
          vehicleId={vehicleId}
          vehicleOptions={vehicles.items}
        />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {!hasAnyRows && !hasCompanyLevel ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              <p>No fuel logs or expenses were recorded in the selected window.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vehicle</TableHead>
                  <TableHead className="text-right tabular-nums">Fuel</TableHead>
                  <TableHead className="text-right tabular-nums">Expenses</TableHead>
                  <TableHead className="text-right tabular-nums">Total</TableHead>
                  <TableHead className="text-right tabular-nums">Fuel logs</TableHead>
                  <TableHead className="text-right tabular-nums">Expense logs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row: PerVehicleCostRow) => (
                  <TableRow key={row.vehicleId}>
                    <TableCell className="text-text-primary font-mono">
                      <Link
                        href={`/vehicles/${row.vehicleId}`}
                        className="hover:text-text-secondary focus-visible:outline-border-focus underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2"
                      >
                        {row.registrationNumber}
                      </Link>
                    </TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatNpr(row.fuelPaisa)}
                    </TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatNpr(row.expensePaisa)}
                    </TableCell>
                    <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                      {formatNpr(row.totalPaisa)}
                    </TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {row.fuelLogCount}
                    </TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {row.expenseLogCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="text-text-primary font-semibold">Totals</TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatNpr(report.totals.fuelPaisa)}
                  </TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatNpr(report.totals.expensePaisa)}
                  </TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatNpr(report.totals.totalPaisa)}
                  </TableCell>
                  <TableCell />
                  <TableCell />
                </TableRow>
                {hasCompanyLevel ? (
                  <TableRow>
                    <TableCell
                      className="text-text-secondary text-sm italic"
                      title="Expenses with no vehicle attribution (e.g., quarterly insurance, office stationery)."
                    >
                      Company-level (not vehicle-attributable)
                    </TableCell>
                    <TableCell className="text-text-muted text-right tabular-nums">—</TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatNpr(report.companyLevel.expensePaisa)}
                    </TableCell>
                    <TableCell className="text-text-muted text-right tabular-nums">—</TableCell>
                    <TableCell className="text-text-muted text-right tabular-nums">—</TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {report.companyLevel.expenseLogCount}
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableFooter>
            </Table>
          )}
        </section>
      </div>
    </main>
  );
}
