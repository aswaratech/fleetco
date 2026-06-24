import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
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
import { formatKm, formatKmPerLitre, formatLiters } from "@/lib/units";

import { PerVehicleEfficiencyFilters } from "./per-vehicle-efficiency-filters";
import type { EfficiencyFlag, PerVehicleEfficiencyReport, PerVehicleEfficiencyRow } from "./types";

// Per-vehicle fuel-efficiency report — Reports v2 (A3 web surface). Completes
// the "fuel efficiency" deliverable named for Reports v1 (docs/product/
// roadmap.md §"Phase 1 — The Spine") that iter-23 left unshipped; landing as
// Reports v2 in the Phase-2 window — deferred Phase-1 daily-use polish, the
// same category as the Home dashboard and the BS-date work. The design
// contract is DESIGN.md §"Surfaces" → "Per-vehicle fuel-efficiency report".
//
// A faithful twin of apps/web/src/app/reports/per-vehicle-cost/page.tsx:
//   - Server-rendered behind the auth gate (session cookie → /login if
//     absent); reads the report + vehicle picker options in parallel.
//   - Filters: from / to (the shipped <NepaliDatePicker>) + an optional
//     single-vehicle narrow, all in URL searchParams. Default window = the
//     current calendar month UTC.
//   - Table: one row per vehicle with activity (no zero-fill — the service
//     omits inactive vehicles), sorted server-side (exception flag first,
//     then registration); the page does not re-sort.
//
// Differences from the cost report, all per the design spec:
//   - No companyLevel block (both inputs — completed trips and fuel logs —
//     are always vehicle-bound).
//   - A Status column rendering the efficiency flag through the shipped
//     <Badge>; `normal` shows NO badge (the absence is the signal).
//   - A coverage note beneath the table: this is a fleet/period-level km/L
//     trend + exception flag, not a forensic per-fill meter (see below).

// Vehicles list response shape — see apps/api/src/modules/vehicles/
// vehicles.controller.ts. We only need the id + registrationNumber pair for
// the picker; the rest of the projection is ignored.
interface VehiclePickerItem {
  id: string;
  registrationNumber: string;
}

interface VehiclesListResponse {
  items: VehiclePickerItem[];
}

// Current calendar month UTC as a [from, to] pair of YYYY-MM-DD strings the
// API parses. Same helper the cost page uses.
function defaultDateRange(): { from: string; to: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const fromDate = new Date(Date.UTC(y, m, 1));
  // Day 0 of the next month is the last day of the current month in UTC.
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

// The Status cell: the efficiency flag rendered through the shipped <Badge>
// per DESIGN.md §"Per-vehicle fuel-efficiency report" → "Table". `normal`
// renders NO badge — within the deviation threshold, the absence of a badge is
// itself the signal (quiet by default). The label on `degraded` is
// deliberately "Efficiency down" (investigate), never "theft" (see the
// coverage note). The switch is exhaustive over the union, so a future flag
// value would surface as a type error here.
function statusBadge(flag: EfficiencyFlag): React.ReactElement | null {
  switch (flag) {
    case "degraded":
      return <Badge variant="error">Efficiency down</Badge>;
    case "improved":
      return <Badge variant="success">Improved</Badge>;
    case "insufficient-data":
      return <Badge variant="neutral">Not enough data</Badge>;
    case "normal":
      return null;
  }
}

interface PerVehicleEfficiencyPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PerVehicleEfficiencyPage({
  searchParams,
}: PerVehicleEfficiencyPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const defaults = defaultDateRange();
  const from = single(params.from) ?? defaults.from;
  const to = single(params.to) ?? defaults.to;
  const vehicleId = single(params.vehicleId) ?? "";

  // Build the API query. ReportsQuerySchema is .strict(), so we forward only
  // the keys it knows about (the same schema the cost route reuses).
  const apiQuery = new URLSearchParams();
  apiQuery.set("from", from);
  apiQuery.set("to", to);
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);

  // Pre-fetch the report and the vehicle picker's options in parallel (take=200
  // = the API's LIST_TAKE_MAX, so the operator usually sees every vehicle in a
  // single dropdown). Same pattern as the cost report.
  let report: PerVehicleEfficiencyReport;
  let vehicles: VehiclesListResponse;
  try {
    [report, vehicles] = await Promise.all([
      apiFetch<PerVehicleEfficiencyReport>(
        `/api/v1/reports/per-vehicle-efficiency?${apiQuery.toString()}`,
      ),
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

  const hasAnyRows = report.rows.length > 0;

  // BS-render the report window for the subtitle (ADR-0031 — "reports" is in
  // the BS-display scope). The `bs` variant keeps the sentence compact; the AD
  // window stays visible in the date pickers, whose value contract is the
  // ISO/AD YYYY-MM-DD the API expects.
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
            <span className="text-text-secondary">Per-vehicle fuel-efficiency report</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">
            Per-vehicle fuel-efficiency report
          </h1>
          <p className="text-text-muted text-sm">
            {hasAnyRows
              ? `${report.rows.length} vehicle${report.rows.length === 1 ? "" : "s"} with activity from ${fromBs} to ${toBs}.`
              : `No fuel or trip activity from ${fromBs} to ${toBs}.`}
          </p>
        </header>

        <PerVehicleEfficiencyFilters
          from={from}
          to={to}
          vehicleId={vehicleId}
          vehicleOptions={vehicles.items}
        />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {!hasAnyRows ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              <p>No fuel or trip activity in the selected window.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vehicle</TableHead>
                  <TableHead className="text-right tabular-nums">Distance</TableHead>
                  <TableHead className="text-right tabular-nums">Litres</TableHead>
                  <TableHead className="text-right tabular-nums">km/L</TableHead>
                  <TableHead className="text-right tabular-nums">NPR/km</TableHead>
                  <TableHead className="text-right tabular-nums">Fuel cost</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row: PerVehicleEfficiencyRow) => (
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
                      {formatKm(row.distanceKm)}
                    </TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatLiters(row.litresMl)}
                    </TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatKmPerLitre(row.kmPerLitre)}
                    </TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatNpr(row.nprPerKm)}
                    </TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatNpr(row.fuelPaisa)}
                    </TableCell>
                    <TableCell>{statusBadge(row.flag)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell className="text-text-primary font-semibold">Totals</TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatKm(report.totals.distanceKm)}
                  </TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatLiters(report.totals.litresMl)}
                  </TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatKmPerLitre(report.totals.kmPerLitre)}
                  </TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatNpr(report.totals.nprPerKm)}
                  </TableCell>
                  <TableCell className="text-text-primary text-right font-semibold tabular-nums">
                    {formatNpr(report.totals.fuelPaisa)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            </Table>
          )}
        </section>

        {hasAnyRows ? (
          <p className="text-text-muted max-w-3xl text-xs">
            Distance is the sum of completed-trip odometer readings, the system of record; the
            figures are a fleet- and period-level trend, not a per-fill meter. Treat a flagged row
            as a prompt to investigate, not proof of theft or fault. Accuracy sharpens once the
            driver app records the odometer at each fill.
          </p>
        ) : null}
      </div>
    </main>
  );
}
