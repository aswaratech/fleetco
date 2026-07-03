import Link from "next/link";
import { redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb } from "@/components/ui/breadcrumb";
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
import { actionBadgeVariant, entityPathFor, formatLatencyMs } from "@/lib/agent-chat";
import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { ActivityFilters } from "./activity-filters";
import type { AgentActionListItem, AgentActionsListResponse } from "./types";

// Agent activity — ADR-0043 A8, built exactly to DESIGN.md §Surfaces "Agent
// activity": the read-only, CROSS-USER audit ledger over AgentAction rows
// ("what did the agent do last week"). It reads actions, never transcripts;
// rows outlive the 180-day transcript prune (the SetNull detach), so this
// surface stays complete after conversations age out. READ-ONLY — the ledger
// is written only by the agent loop.
//
// Server-rendered, mirroring /notification-logs in shape (auth gate → API
// fetch → filters + table + pagination, all state in URL searchParams). The
// endpoint rides the agent:use class gate (ADMIN-only in v1); a non-ADMIN
// navigating directly gets the API's 403 rendered as the plain fact line.
//
// Tier-2 discipline: argsJson/previousJson render for the authorized ADMIN
// inside the Details disclosure and go nowhere else — never into client
// logging, never into URLs (anti-pattern #15).

const DEFAULT_PAGE_SIZE = 20;

interface ActivityPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function AgentActivityPage({
  searchParams,
}: ActivityPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const toolName = single(params.toolName);
  const startDate = single(params.startDate);
  const endDate = single(params.endDate);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(status ?? toolName ?? startDate ?? endDate);

  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (toolName) apiQuery.set("toolName", toolName);
  if (startDate) apiQuery.set("startDate", startDate);
  if (endDate) apiQuery.set("endDate", endDate);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: AgentActionsListResponse;
  try {
    data = await apiFetch<AgentActionsListResponse>(`/api/v1/agent/actions?${apiQuery.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    if (error instanceof ApiError && error.status === 403) {
      // DESIGN.md §"Agent activity": the fact, stated plainly.
      return (
        <ActivityShell>
          <p className="text-text-muted text-sm">
            Agent activity is available to the ADMIN role only.
          </p>
        </ActivityShell>
      );
    }
    throw error;
  }

  const urlSearchParams = new URLSearchParams();
  if (status) urlSearchParams.set("status", status);
  if (toolName) urlSearchParams.set("toolName", toolName);
  if (startDate) urlSearchParams.set("startDate", startDate);
  if (endDate) urlSearchParams.set("endDate", endDate);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <ActivityShell
      subline={
        data.total === 0
          ? hasActiveFilter
            ? "No actions match the current filter."
            : "No agent actions yet."
          : `${data.total} recorded.`
      }
    >
      <ActivityFilters
        status={status}
        toolName={toolName}
        startDate={startDate}
        endDate={endDate}
      />

      <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
        {data.items.length === 0 ? (
          <div className="text-text-secondary space-y-3 p-8 text-sm">
            {hasActiveFilter ? (
              <p>No actions match the current filter.</p>
            ) : (
              <p>No agent actions yet.</p>
            )}
          </div>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHeader
                    basePath="/agent/activity"
                    column="createdAt"
                    activeColumn={data.sortBy}
                    activeDir={data.sortDir}
                    searchParams={urlSearchParams}
                  >
                    When
                  </SortableHeader>
                  <TableHead>Tool</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((action) => (
                  <ActivityRow key={action.id} action={action} />
                ))}
              </TableBody>
            </Table>
            <Pagination
              basePath="/agent/activity"
              total={data.total}
              skip={data.skip}
              take={data.take}
              searchParams={urlSearchParams}
            />
          </>
        )}
      </section>
    </ActivityShell>
  );
}

function ActivityShell({
  children,
  subline,
}: {
  children: React.ReactNode;
  subline?: string;
}): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Agent activity" }]} />
          <h1 className="text-text-primary text-2xl font-semibold">Agent activity</h1>
          <p className="text-text-muted text-sm">
            {subline ?? "Every tool call the agent has made, across all users."}
          </p>
        </header>
        {children}
      </div>
    </main>
  );
}

function ActivityRow({ action }: { action: AgentActionListItem }): React.ReactElement {
  const entityHref =
    action.resultEntityType !== null && action.resultEntityId !== null
      ? entityPathFor(action.resultEntityType, action.resultEntityId)
      : null;
  return (
    <TableRow>
      <TableCell className="text-text-primary tabular-nums">
        <NepaliDate iso={action.createdAt} format="bs" />
      </TableCell>
      <TableCell className="text-text-secondary font-mono text-xs">{action.toolName}</TableCell>
      <TableCell>
        <Badge variant={actionBadgeVariant(action.status)}>{action.status}</Badge>
      </TableCell>
      <TableCell className="text-text-secondary tabular-nums">
        {formatLatencyMs(action.latencyMs)}
      </TableCell>
      <TableCell className="text-text-secondary max-w-40 truncate" title={action.user.email}>
        {action.user.name ?? action.user.email}
      </TableCell>
      <TableCell>
        {entityHref !== null ? (
          <Link href={entityHref} className="text-text-accent text-xs underline underline-offset-2">
            {entityHref}
          </Link>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </TableCell>
      <TableCell>
        <details>
          <summary className="text-text-muted cursor-pointer text-xs">Details</summary>
          <pre className="text-text-secondary mt-1 max-w-md overflow-x-auto text-xs">
            {JSON.stringify(action.argsJson, null, 2)}
          </pre>
          {action.previousJson != null ? (
            <>
              <p className="text-text-muted mt-2 text-xs">Pre-image (before the update):</p>
              <pre className="text-text-secondary mt-1 max-w-md overflow-x-auto text-xs">
                {JSON.stringify(action.previousJson, null, 2)}
              </pre>
            </>
          ) : null}
        </details>
      </TableCell>
    </TableRow>
  );
}
