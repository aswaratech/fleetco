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
import { TRACKER_STATUS_BADGE_VARIANTS, TRACKER_STATUS_LABELS } from "@/lib/trackers-schema";
import { getServerSession } from "@/lib/session";

import { TrackersFilters } from "./trackers-filters";
import type { Tracker } from "./types";

// Tracker register list — ADR-0042 M4 (web admin CRUD scaffold). Server-
// rendered; reads the session cookie, redirects to /login if absent, and
// fetches the list from the API (`trackers:read` is ADMIN + OFFICE_STAFF —
// the API enforces it; the web app does no extra role-gating, mirroring
// the other aggregates).
//
// Mirrors apps/web/src/app/(app)/geofences/page.tsx in shape:
//   - Filter: status (single-value select in the UI; the API accepts the
//     comma-separated multi-value list). A `vehicleId` URL param is
//     forwarded to the API but not surfaced in the toolbar, so a future
//     "tracker for this vehicle" deep-link works without a new control.
//   - Sort: clickable headers on the whitelisted sortable columns.
//   - Pagination: DEFAULT_PAGE_SIZE 20 matches the API's LIST_TAKE_DEFAULT.
//
// VEHICLE RESOLUTION: unlike geofences, the list response nests the
// assigned vehicle's registration (a two-field projection the API includes
// precisely for this page), so there is no enrichment fetch here.

type SortColumn = "createdAt" | "imei" | "status" | "installedAt" | "label";
type SortDir = "asc" | "desc";

// The API echoes the effective sort + pagination + total back so the UI
// renders from the same authoritative numbers that ran the query.
interface TrackersListResponse {
  items: Tracker[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

interface TrackersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function TrackersPage({
  searchParams,
}: TrackersPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const vehicleId = single(params.vehicleId);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(status) || Boolean(vehicleId);

  // Forward only the params the API knows about; unknown query keys would
  // 400 (the schema is .strict()). skip/take defaults applied here so every
  // API request is explicit.
  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (vehicleId) apiQuery.set("vehicleId", vehicleId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: TrackersListResponse;
  try {
    data = await apiFetch<TrackersListResponse>(
      `/api/v1/telematics/trackers?${apiQuery.toString()}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // searchParams the in-page links operate on — mirror the URL's params,
  // not the API-mangled set (which always carries explicit skip/take).
  const urlSearchParams = new URLSearchParams();
  if (status) urlSearchParams.set("status", status);
  if (vehicleId) urlSearchParams.set("vehicleId", vehicleId);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Trackers" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Trackers</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No trackers match the current filters."
                  : "No trackers registered."
                : `${data.total} registered.`}
            </p>
          </div>
          <Button asChild>
            <Link href="/trackers/new">New tracker</Link>
          </Button>
        </header>

        <TrackersFilters status={status} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No trackers match the current filters.</p>
              ) : (
                <>
                  <p>No trackers registered.</p>
                  <p>
                    <Link
                      href="/trackers/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Register the first tracker.
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
                      basePath="/trackers"
                      column="imei"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      IMEI
                    </SortableHeader>
                    <SortableHeader
                      basePath="/trackers"
                      column="status"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Status
                    </SortableHeader>
                    <TableHead>Vehicle</TableHead>
                    <SortableHeader
                      basePath="/trackers"
                      column="label"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Label
                    </SortableHeader>
                    <SortableHeader
                      basePath="/trackers"
                      column="installedAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Installed
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((t) => (
                    // Stretched-link pattern (matches the other list pages).
                    <TableRow key={t.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary font-mono">
                        <Link
                          href={`/trackers/${t.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {t.imei}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant={TRACKER_STATUS_BADGE_VARIANTS[t.status]}>
                          {TRACKER_STATUS_LABELS[t.status] ?? t.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {t.vehicle === null ? (
                          "—"
                        ) : (
                          // z-10 lifts the deep-link above the row's stretched
                          // link so both targets stay clickable.
                          <Link
                            href={`/vehicles/${t.vehicle.id}`}
                            className="text-text-primary relative z-10 font-mono underline-offset-2 hover:underline"
                          >
                            {t.vehicle.registrationNumber}
                          </Link>
                        )}
                      </TableCell>
                      <TableCell className="text-text-secondary">{t.label ?? "—"}</TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {t.installedAt === null ? (
                          "—"
                        ) : (
                          <NepaliDate iso={t.installedAt} format="bs" />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/trackers"
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
