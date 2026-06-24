import Link from "next/link";
import { notFound, redirect } from "next/navigation";

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
import { CUSTOMER_STATUS_LABELS } from "@/lib/customers-schema";
import { computeInvoiceTaxPreview } from "@/lib/invoices-tax";
import { formatNpr } from "@/lib/money";
import { getServerSession } from "@/lib/session";

import { CancelInvoiceDialog } from "./cancel-invoice-dialog";
import { CreateCreditNoteButton } from "./create-credit-note-button";
import { IssueInvoiceButton } from "./issue-invoice-button";
import { InvoiceTaxSummary, type InvoiceTaxSummaryFigures } from "../invoice-tax-summary";
import {
  DOCUMENT_TYPE_BADGE,
  DOCUMENT_TYPE_LABELS,
  INVOICE_SERVICE_TYPE_LABELS,
  INVOICE_STATUS_BADGE,
  INVOICE_STATUS_LABELS,
  type InvoiceDetail,
} from "../types";

// Invoice detail — Program D / D6 (ADR-0039 c8). Server-rendered shell (auth gate;
// redirect to /login if absent); fetches the invoice via apiFetch and surfaces 404
// through notFound(). Mirrors apps/web/src/app/jobs/[id]/page.tsx in shape.
//
// The DRAFT-editable / ISSUED-read-only split is enforced VISUALLY here (ADR-0039
// c5): a DRAFT shows Edit / Issue / Cancel + a watermarked draft-preview download;
// an ISSUED invoice is read-only + a frozen-PDF download + Create credit note; a
// CANCELLED invoice is read-only + a preview download. The tax breakdown renders
// the FROZEN snapshot for an ISSUED invoice (never recomputed — the anti-tamper
// freeze) and a PROVISIONAL preview for a DRAFT.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function InvoiceDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let invoice: InvoiceDetail;
  try {
    invoice = await apiFetch<InvoiceDetail>(`/api/v1/invoices/${id}`);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) redirect("/login");
      if (error.status === 404) notFound();
    }
    throw error;
  }

  const isDraft = invoice.status === "DRAFT";
  const isIssued = invoice.status === "ISSUED";
  const statusLabel = INVOICE_STATUS_LABELS[invoice.status] ?? invoice.status;
  const docTypeLabel = DOCUMENT_TYPE_LABELS[invoice.documentType] ?? invoice.documentType;
  const heading =
    invoice.number ??
    (invoice.documentType === "CREDIT_NOTE" ? "Draft credit note" : "Draft invoice");
  const pdfLabel = isIssued ? "Download PDF" : "Download draft preview";

  // The tax breakdown: an ISSUED invoice renders its FROZEN columns; a
  // DRAFT/CANCELLED invoice renders a provisional preview from the current lines
  // (when a service type is set). null preview = not yet valid (e.g. discount >
  // subtotal) — surfaced as a note rather than a wrong number.
  let figures: InvoiceTaxSummaryFigures | null = null;
  let taxNote: string | null = null;
  if (isIssued && invoice.grossPaisa !== null) {
    figures = {
      subtotalPaisa: invoice.subtotalPaisa ?? 0,
      discountPaisa: invoice.discountPaisa ?? 0,
      vatRateBp: invoice.vatRateBp ?? 0,
      vatPaisa: invoice.vatPaisa ?? 0,
      grossPaisa: invoice.grossPaisa,
      tdsRateBp: invoice.tdsRateBp ?? 0,
      tdsPaisa: invoice.tdsPaisa ?? 0,
      netReceivablePaisa: invoice.netReceivablePaisa ?? 0,
    };
  } else if (invoice.serviceType !== null) {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: invoice.lines.map((line) => line.lineAmountPaisa),
      discountPaisa: invoice.discountPaisa,
      serviceType: invoice.serviceType,
    });
    if (preview) {
      figures = preview;
    } else {
      taxNote = "Tax breakdown unavailable: the discount exceeds the subtotal.";
    }
  } else {
    taxNote = "Set a service type to preview the VAT/TDS breakdown.";
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
              <Link href="/" className="hover:text-text-primary">
                FleetCo
              </Link>
              <span aria-hidden="true"> › </span>
              <Link href="/invoices" className="hover:text-text-primary">
                Invoices
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary font-mono">{heading}</span>
            </nav>
            <h1 className="text-text-primary font-mono text-2xl font-semibold">{heading}</h1>
            <p className="text-text-muted flex flex-wrap items-center gap-2 text-sm">
              <span>{invoice.customer.name}</span>
              <Badge variant={INVOICE_STATUS_BADGE[invoice.status]}>{statusLabel}</Badge>
              <Badge variant={DOCUMENT_TYPE_BADGE[invoice.documentType]}>{docTypeLabel}</Badge>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost">
              <a href={`/invoices/${invoice.id}/pdf`} target="_blank" rel="noopener noreferrer">
                {pdfLabel}
              </a>
            </Button>
            {isDraft ? (
              <>
                <Button asChild variant="outline">
                  <Link href={`/invoices/${invoice.id}/edit`}>Edit</Link>
                </Button>
                <CancelInvoiceDialog id={invoice.id} label={heading} />
                <IssueInvoiceButton id={invoice.id} />
              </>
            ) : null}
            {isIssued && invoice.documentType === "INVOICE" ? (
              <CreateCreditNoteButton id={invoice.id} label={heading} />
            ) : null}
          </div>
        </header>

        {/* Customer */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Customer
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Name"
              value={
                <Link
                  href={`/customers/${invoice.customer.id}`}
                  className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                >
                  {invoice.customer.name}
                </Link>
              }
            />
            <DetailRow
              label="Customer status"
              value={CUSTOMER_STATUS_LABELS[invoice.customer.status] ?? invoice.customer.status}
            />
            <DetailRow label="Buyer PAN" value={invoice.customer.panNumber ?? "—"} mono />
            <DetailRow label="Contact person" value={invoice.customer.contactPerson ?? "—"} />
          </dl>
        </section>

        {/* Invoice header */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            {docTypeLabel}
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Number" value={invoice.number ?? "Not yet issued"} mono />
            <DetailRow label="Status" value={statusLabel} />
            <DetailRow
              label="Service type"
              value={
                invoice.serviceType
                  ? INVOICE_SERVICE_TYPE_LABELS[invoice.serviceType]
                  : "Not set (required to issue)"
              }
            />
            <DetailRow label="Issue date" value={<NepaliDate iso={invoice.issuedAt} />} />
            <DetailRow
              label="Job"
              value={
                invoice.job ? (
                  <Link
                    href={`/jobs/${invoice.job.id}`}
                    className="text-text-primary hover:text-text-secondary font-mono underline-offset-2 hover:underline"
                  >
                    {invoice.job.jobNumber}
                  </Link>
                ) : (
                  "—"
                )
              }
            />
            {invoice.originalInvoiceId ? (
              <DetailRow
                label="Corrects invoice"
                value={
                  <Link
                    href={`/invoices/${invoice.originalInvoiceId}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    View original
                  </Link>
                }
              />
            ) : null}
          </dl>
        </section>

        {/* Lines */}
        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          <div className="px-6 pt-6">
            <h2 className="text-text-muted text-xs font-medium tracking-wide uppercase">Lines</h2>
          </div>
          {invoice.lines.length === 0 ? (
            <p className="text-text-secondary p-6 text-sm">
              No lines yet.{" "}
              {isDraft ? (
                <Link
                  href={`/invoices/${invoice.id}/edit`}
                  className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                >
                  Add the first line
                </Link>
              ) : null}
            </p>
          ) : (
            <div className="mt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right tabular-nums">Qty</TableHead>
                    <TableHead className="text-right tabular-nums">Unit price</TableHead>
                    <TableHead className="text-right tabular-nums">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="text-text-secondary">{line.description}</TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {line.quantity}
                      </TableCell>
                      <TableCell className="text-text-secondary text-right tabular-nums">
                        {formatNpr(line.unitPricePaisa)}
                      </TableCell>
                      <TableCell className="text-text-primary text-right tabular-nums">
                        {formatNpr(line.lineAmountPaisa)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        {/* Tax breakdown */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Tax breakdown
          </h2>
          {figures ? (
            <InvoiceTaxSummary figures={figures} provisional={!isIssued} />
          ) : (
            <p className="text-text-secondary text-sm">{taxNote}</p>
          )}
        </section>

        {/* Audit */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(invoice.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(invoice.updatedAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}

interface DetailRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}

function DetailRow({ label, value, mono, className }: DetailRowProps): React.ReactElement {
  const valueClass = ["text-text-primary text-sm", mono ? "font-mono" : ""]
    .filter(Boolean)
    .join(" ");
  const wrapperClass = ["space-y-1", className].filter(Boolean).join(" ");
  return (
    <div className={wrapperClass}>
      <dt className="text-text-muted text-xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
