import Link from "next/link";
import { redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
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
import {
  reminderKindLabel,
  stateBadgeVariant,
  stateLabel,
  subjectTypeLabel,
} from "@/lib/notification-logs";
import { getServerSession } from "@/lib/session";

import { NotificationLogsFilters } from "./notification-logs-filters";
import type { NotificationLog } from "./types";

// NotificationLog history — the reminder-delivery audit view (ADR-0038 C4). It
// makes the send-once ledger (written by the C2/C3 scan→send worker) VISIBLE:
// "we notified about that lapse on date X" (the ADR-0013 audit value). It is
// READ-ONLY — there is no New / Edit / Delete; the ledger is append-only and
// written only by the background worker.
//
// Server-rendered; mirrors apps/web/src/app/customers/page.tsx in shape (auth
// gate → API fetch → table + filter + pagination, all state in URL searchParams).
// The only client island is NotificationLogsFilters (the shadcn Select). The
// "Sent" column is the one sortable header (sentAt, the default); the API also
// accepts a createdAt sort but there is no createdAt column to surface it.

// Sortable columns exposed in the UI — a subset of the API whitelist
// (SORTABLE_COLUMNS in notification-logs.schemas.ts). Only `sentAt` gets a header
// affordance; `createdAt` is API-reachable but uncolumned here.
type SortColumn = "sentAt" | "createdAt";
type SortDir = "asc" | "desc";

interface NotificationLogsListResponse {
  items: NotificationLog[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

// The reminder-scan cadence, mirrored from REMINDER_SCAN_CRON in
// apps/api/src/modules/notifications/notification.constants.ts ("0 1 * * *").
// Rendered as read-only informational text; the cron itself is operator-tunable
// at deploy, not editable here (ADR-0038 c3 / C4).
const SCAN_CADENCE_LABEL = "once daily at 01:00 UTC (about 06:45 in Nepal)";

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
  const href = `/notification-logs${sortParams(searchParams, column, activeColumn, activeDir)}`;
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
  const prevHref = `/notification-logs${paginationParams(searchParams, Math.max(0, skip - safeTake))}`;
  const nextHref = `/notification-logs${paginationParams(searchParams, skip + safeTake)}`;

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
              <Link
                href={`/notification-logs${paginationParams(searchParams, (p - 1) * safeTake)}`}
              >
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

// Read-only delivery-configuration panel (ADR-0038 C4). The cadence + recipient
// policy are operator-configured at deploy (env / the scan cron), NOT editable
// in-app — shown here so an operator reading an empty or sparse log understands
// when reminders run and who receives them. Honest about the deploy dependency:
// real email delivery needs the production provider configured (ADR-0038 c1/c9).
function DeliveryConfigPanel(): React.ReactElement {
  return (
    <section className="border-border-subtle bg-surface-raised text-text-secondary space-y-1 rounded border p-4 text-sm shadow-sm">
      <h2 className="text-text-muted text-xs font-medium tracking-wide uppercase">
        Delivery configuration
      </h2>
      <p>
        The reminder scan runs <span className="text-text-primary">{SCAN_CADENCE_LABEL}</span>,
        emailing a Bikram Sambat digest of newly due or overdue items.
      </p>
      <p>
        Recipients are the ADMIN users&apos; email addresses, plus any addresses set via the{" "}
        <code className="text-text-primary font-mono text-xs">NOTIFICATION_RECIPIENTS</code>{" "}
        environment override.
      </p>
      <p className="text-text-muted">
        Recipients and cadence are configured by the operator at deploy and are not editable here.
        Email delivery is active only once the production email provider is configured.
      </p>
    </section>
  );
}

interface NotificationLogsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function NotificationLogsPage({
  searchParams,
}: NotificationLogsPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const subjectType = single(params.subjectType);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(subjectType);

  const apiQuery = new URLSearchParams();
  if (subjectType) apiQuery.set("subjectType", subjectType);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: NotificationLogsListResponse;
  try {
    data = await apiFetch<NotificationLogsListResponse>(
      `/api/v1/notification-logs?${apiQuery.toString()}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const urlSearchParams = new URLSearchParams();
  if (subjectType) urlSearchParams.set("subjectType", subjectType);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Reminder history</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Reminder history</h1>
          <p className="text-text-muted text-sm">
            {data.total === 0
              ? hasActiveFilter
                ? "No reminders match the current filter."
                : "No reminders sent yet."
              : `${data.total} sent.`}
          </p>
        </header>

        <DeliveryConfigPanel />

        <NotificationLogsFilters subjectType={subjectType} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No reminders match the current filter.</p>
              ) : (
                <p>No reminders sent yet.</p>
              )}
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHeader
                      column="sentAt"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Sent
                    </SortableHeader>
                    <TableHead>Subject</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Provider message id</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((log) => (
                    <TableRow key={log.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary tabular-nums">
                        <Link
                          href={`/notification-logs/${log.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          <NepaliDate iso={log.sentAt} format="bs" />
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        <span className="text-text-primary">
                          {subjectTypeLabel(log.subjectType)}
                        </span>
                        <span className="text-text-muted block truncate font-mono text-xs">
                          {log.subjectId}
                        </span>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {reminderKindLabel(log.reminderKind)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={stateBadgeVariant(log.state)}>
                          {stateLabel(log.state)}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className="text-text-secondary max-w-48 truncate"
                        title={log.recipient}
                      >
                        {log.recipient}
                      </TableCell>
                      <TableCell
                        className="text-text-muted max-w-40 truncate font-mono text-xs"
                        title={log.providerMessageId ?? undefined}
                      >
                        {log.providerMessageId ?? "—"}
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
