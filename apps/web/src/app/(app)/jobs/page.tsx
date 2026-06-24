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
import { getServerSession } from "@/lib/session";

import { JobsFilters } from "./jobs-filters";
import { JOB_STATUS_LABELS, type JobListItem, type JobStatus } from "./types";

// Jobs list — Phase 1 vertical slice, iter 17 (read path). Server-
// rendered; reads the session cookie, redirects to /login if absent,
// fetches the list from the API (apps/api owns the auth handler per
// ADR-0021). Mirrors apps/web/src/app/customers/page.tsx and the Trips
// list in shape:
//   - Filter: status (single-value select; the API accepts a comma-
//     separated multi-value list). The customerId filter the API
//     supports is set by a future "jobs for this customer" link, not
//     surfaced in the toolbar (same as Trips' vehicleId / driverId).
//   - Sort: clickable headers on the two whitelisted sortable columns
//     exposed here (jobNumber, scheduledStartDate). createdAt is the
//     default sort and has no rendered column.
//   - Pagination: numbered page links; DEFAULT_PAGE_SIZE 20 matches the
//     API's LIST_TAKE_DEFAULT; "Showing M–N of T" per DESIGN.md §Tables.
//
// State all lives in URL searchParams — server-rendered, no client-side
// filtering. The only client island is `JobsFilters`. No write path in
// iter 17: the header has no "New job" CTA and the empty state's
// "Book the first job." copy is plain text (iter 18 wires it to
// /jobs/new), per the kickoff.

type SortColumn = "jobNumber" | "scheduledStartDate" | "createdAt";
type SortDir = "asc" | "desc";

interface JobsListResponse {
  items: JobListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

interface JobsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function JobsPage({
  searchParams,
}: JobsPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const customerId = single(params.customerId);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(status) || Boolean(customerId);

  // Forward only the params the API knows about; unknown query keys
  // would 400 (the schema is .strict()). skip/take defaults applied
  // here so every API request is explicit.
  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (customerId) apiQuery.set("customerId", customerId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: JobsListResponse;
  try {
    data = await apiFetch<JobsListResponse>(`/api/v1/jobs?${apiQuery.toString()}`);
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
  if (customerId) urlSearchParams.set("customerId", customerId);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Jobs" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Jobs</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No jobs match the current filters."
                  : "No jobs on file."
                : `${data.total} on file.`}
            </p>
          </div>
          {/* "New job" CTA wired in iter 18 (write path) — mirror of
              the Customers iter-15 → iter-16 header change. */}
          <Button asChild>
            <Link href="/jobs/new">New job</Link>
          </Button>
        </header>

        <JobsFilters status={status} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No jobs match the current filters.</p>
              ) : (
                // iter 18 wires "Book the first job." to /jobs/new.
                <p>
                  No jobs on file.{" "}
                  <Link
                    href="/jobs/new"
                    className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                  >
                    Book the first job
                  </Link>
                  .
                </p>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader
                      basePath="/jobs"
                      column="jobNumber"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Job number
                    </SortableHeader>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <SortableHeader
                      basePath="/jobs"
                      column="scheduledStartDate"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                      className="text-right tabular-nums"
                    >
                      Scheduled start
                    </SortableHeader>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((j) => (
                    // Stretched-link pattern (matches the other list pages).
                    <TableRow key={j.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary font-mono">
                        <Link
                          href={`/jobs/${j.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {j.jobNumber}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">{j.customer.name}</TableCell>
                      <TableCell className="text-text-secondary">
                        {JOB_STATUS_LABELS[j.status as JobStatus] ?? j.status}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={j.scheduledStartDate} format="bs" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/jobs"
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
