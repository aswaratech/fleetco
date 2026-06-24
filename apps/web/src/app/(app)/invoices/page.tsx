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
import { formatNpr } from "@/lib/money";
import { getServerSession } from "@/lib/session";

import { InvoicesFilters, type CustomerFilterOption } from "./invoices-filters";
import {
  DOCUMENT_TYPE_BADGE,
  DOCUMENT_TYPE_LABELS,
  INVOICE_STATUS_BADGE,
  INVOICE_STATUS_LABELS,
  type DocumentType,
  type InvoiceListItem,
  type InvoiceStatus,
} from "./types";

// Invoices list — Program D / D6 (the first web invoicing surface; ADR-0039 c8).
// Server-rendered; reads the session cookie, redirects to /login if absent,
// fetches the list from the API (apps/api owns the auth handler per ADR-0021).
// Mirrors apps/web/src/app/jobs/page.tsx in shape:
//   - Filters: status / documentType / customer (a native-select toolbar island).
//   - Sort: the two whitelisted columns the API exposes — `number` (a clickable
//     header) and `createdAt` (the default sort, no rendered column).
//   - Pagination: numbered page links; DEFAULT_PAGE_SIZE 20 matches the API's
//     LIST_TAKE_DEFAULT; "Showing M–N of T" per DESIGN.md §Tables.
//
// Columns: Number / Customer / Status / Document type / Gross / Net receivable /
// Issue date. The frozen money + number + issue date are NULL on a DRAFT (em-dash);
// Status + Document type render the shipped <Badge> (existing tokens, no new one).
// State all lives in URL searchParams — server-rendered, no client filtering.

type SortColumn = "number" | "createdAt";
type SortDir = "asc" | "desc";

interface InvoicesListResponse {
  items: InvoiceListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: SortColumn;
  sortDir: SortDir;
}

const DEFAULT_PAGE_SIZE = 20;

interface InvoicesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

interface CustomersListResponse {
  items: CustomerFilterOption[];
}

export default async function InvoicesPage({
  searchParams,
}: InvoicesPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const status = single(params.status);
  const documentType = single(params.documentType);
  const customerId = single(params.customerId);
  const sortByParam = single(params.sortBy);
  const sortDirParam = single(params.sortDir);
  const skipRaw = Number(single(params.skip) ?? "0");
  const skip = Number.isFinite(skipRaw) && skipRaw >= 0 ? Math.floor(skipRaw) : 0;
  const take = DEFAULT_PAGE_SIZE;

  const hasActiveFilter = Boolean(status) || Boolean(documentType) || Boolean(customerId);

  // Forward only the params the API knows about; unknown query keys would 400
  // (the schema is .strict()). skip/take defaults applied here so every API
  // request is explicit.
  const apiQuery = new URLSearchParams();
  if (status) apiQuery.set("status", status);
  if (documentType) apiQuery.set("documentType", documentType);
  if (customerId) apiQuery.set("customerId", customerId);
  if (sortByParam) apiQuery.set("sortBy", sortByParam);
  if (sortDirParam) apiQuery.set("sortDir", sortDirParam);
  apiQuery.set("skip", String(skip));
  apiQuery.set("take", String(take));

  // The list + the active customers for the customer filter, fetched in
  // parallel. A customers fetch that 401s redirects to login like the list.
  let data: InvoicesListResponse;
  let customers: CustomerFilterOption[] = [];
  try {
    const [list, customerList] = await Promise.all([
      apiFetch<InvoicesListResponse>(`/api/v1/invoices?${apiQuery.toString()}`),
      apiFetch<CustomersListResponse>("/api/v1/customers?sortBy=name&sortDir=asc&take=200"),
    ]);
    data = list;
    customers = customerList.items;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // searchParams the in-page links operate on — mirror the URL's params, not the
  // API-mangled set (which always carries explicit skip/take).
  const urlSearchParams = new URLSearchParams();
  if (status) urlSearchParams.set("status", status);
  if (documentType) urlSearchParams.set("documentType", documentType);
  if (customerId) urlSearchParams.set("customerId", customerId);
  if (sortByParam) urlSearchParams.set("sortBy", sortByParam);
  if (sortDirParam) urlSearchParams.set("sortDir", sortDirParam);
  if (skip > 0) urlSearchParams.set("skip", String(skip));

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Invoices" }]} />
            <h1 className="text-text-primary text-2xl font-semibold">Invoices</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0
                ? hasActiveFilter
                  ? "No invoices match the current filters."
                  : "No invoices on file."
                : `${data.total} on file.`}
            </p>
          </div>
          <Button asChild>
            <Link href="/invoices/new">New invoice</Link>
          </Button>
        </header>

        <InvoicesFilters
          status={status}
          documentType={documentType}
          customerId={customerId}
          customers={customers}
        />

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary space-y-3 p-8 text-sm">
              {hasActiveFilter ? (
                <p>No invoices match the current filters.</p>
              ) : (
                <p>
                  No invoices on file.{" "}
                  <Link
                    href="/invoices/new"
                    className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                  >
                    Draft the first invoice
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
                      basePath="/invoices"
                      column="number"
                      activeColumn={data.sortBy}
                      activeDir={data.sortDir}
                      searchParams={urlSearchParams}
                    >
                      Number
                    </SortableHeader>
                    <TableHead>Customer</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Document type</TableHead>
                    <TableHead className="text-right tabular-nums">Gross</TableHead>
                    <TableHead className="text-right tabular-nums">Net receivable</TableHead>
                    <TableHead className="text-right tabular-nums">Issue date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((inv) => (
                    <TableRow key={inv.id} className="relative cursor-pointer">
                      <TableCell className="text-text-primary font-mono">
                        <Link
                          href={`/invoices/${inv.id}`}
                          className="focus-visible:outline-border-focus before:absolute before:inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        >
                          {inv.number ?? <span className="text-text-muted">— draft</span>}
                        </Link>
                      </TableCell>
                      <TableCell className="text-text-secondary">{inv.customer.name}</TableCell>
                      <TableCell>
                        <Badge variant={INVOICE_STATUS_BADGE[inv.status as InvoiceStatus]}>
                          {INVOICE_STATUS_LABELS[inv.status as InvoiceStatus] ?? inv.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={DOCUMENT_TYPE_BADGE[inv.documentType as DocumentType]}>
                          {DOCUMENT_TYPE_LABELS[inv.documentType as DocumentType] ??
                            inv.documentType}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatNpr(inv.grossPaisa)}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatNpr(inv.netReceivablePaisa)}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        <NepaliDate iso={inv.issuedAt} format="bs" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                basePath="/invoices"
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
