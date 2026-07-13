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
import { SITE_KIND_LABELS } from "@/lib/sites-schema";

import { SitesFilters } from "./sites-filters";
import type { Site } from "./types";

// Site list — ADR-0047 W5 (admin Sites web surface). Server-rendered; the (app)
// layout provides the auth gate, and the API enforces the `sites:*` capability
// (ADMIN + OFFICE_STAFF), so the web does no extra role-gating — mirroring the
// other aggregates.
//
// Mirrors apps/web/src/app/(app)/geofences/page.tsx in shape:
//   - Filter: kind (single-value select in the UI; the API accepts the
//     comma-separated multi-value list).
//   - Sort: clickable headers on the two whitelisted sortable columns
//     (name, createdAt — the API's whitelist). Kind / Location / Contact are
//     not sortable, so they are plain headers.
//   - Pagination: numbered page links; DEFAULT_PAGE_SIZE 20 matches the API's
//     LIST_TAKE_DEFAULT.
//
// Unlike Geofences there is NO owning-customer to resolve — a Site is
// company-level master data — so the list is a single fetch. DESIGN.md §Sites
// fixes the columns: Name · Kind (a <Badge variant="neutral">) · Location
// (the address when present, else the coordinates rendered compactly) ·
// Contact (the site contact NAME — the phone never appears in a list URL,
// anti-pattern #15) · Created (<NepaliDate format="bs">).

type SortColumn = "name" | "createdAt";
type SortDir = "asc" | "desc";

// The API echoes the effective sort + pagination + total back so the UI renders
// from the same authoritative numbers that ran the query.
interface SitesListResponse {
  items: Site[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

interface SitesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

// Compact coordinate rendering for the Location column when a Site has no
// address — "27.7172, 85.3240" (lat, lng — the human display order; 4 dp is
// street-level and keeps the cell narrow). DESIGN.md §Sites.
function compactCoords(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

export default async function SitesPage({
  searchParams,
}: SitesPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const kind = single(params.kind);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(kind);

  // Forward only the params the API knows about; unknown query keys would 400
  // (the schema is .strict()). skip/take defaults applied here so every API
  // request is explicit.
  const apiQuery = new URLSearchParams();
  if (kind) apiQuery.set("kind", kind);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  let data: SitesListResponse;
  try {
    data = await apiFetch<SitesListResponse>(`/api/v1/sites?${apiQuery.toString()}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // searchParams the in-page links operate on — mirror the URL's params, not
  // the API-mangled set (which always carries explicit skip/take).
  const urlSearchParams = new URLSearchParams();
  if (kind) urlSearchParams.set("kind", kind);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Sites" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Sites</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No sites match the current filters."
                  : "No sites on file."
                : `${data.total} on file.`}
            </p>
          </div>
          <Button asChild>
            <Link href="/sites/new">New site</Link>
          </Button>
        </header>

        <SitesFilters kind={kind} />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No sites match the current filters.</p>
              ) : (
                <>
                  <p>No sites on file.</p>
                  <p>
                    <Link
                      href="/sites/new"
                      className="text-text-primary underline underline-offset-4"
                    >
                      Add the first site.
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
                      basePath="/sites"
                      column="name"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Name
                    </SortableHeader>
                    <TableHead>Kind</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Contact</TableHead>
                    <SortableHeader
                      basePath="/sites"
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
                  {data.items.map((s) => (
                    // Stretched-link pattern (matches the other list pages).
                    <TableRow key={s.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary">
                        <Link
                          href={`/sites/${s.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {s.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="neutral">{SITE_KIND_LABELS[s.kind] ?? s.kind}</Badge>
                      </TableCell>
                      <TableCell className="text-text-secondary">
                        {s.address && s.address.length > 0 ? (
                          s.address
                        ) : (
                          <span className="tabular-nums">
                            {compactCoords(s.latitude, s.longitude)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-text-secondary">{s.contactName ?? "—"}</TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={s.createdAt} format="bs" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/sites"
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
