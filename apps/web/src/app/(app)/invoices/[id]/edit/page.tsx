import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { computeInvoiceTaxPreview } from "@/lib/invoices-tax";
import { paisaToRupeesInput } from "@/lib/money";
import { getServerSession } from "@/lib/session";

import { BuildFromJobForm, type TripOption } from "./build-from-job-form";
import { EditInvoiceHeaderForm } from "./edit-invoice-header-form";
import { InvoiceLinesSection } from "./invoice-lines-section";
import { InvoiceTaxSummary, type InvoiceTaxSummaryFigures } from "../../invoice-tax-summary";
import type { InvoiceDetail } from "../../types";
import type { JobListItem } from "../../../jobs/types";
import type { TripListItem } from "../../../trips/types";

// Edit a DRAFT invoice — Program D / D6 (ADR-0039 c2, c5, c8). The DRAFT workbench:
// edit the header (service type / discount / job), manage lines (add / inline-edit /
// remove + build-from-job), and watch the provisional VAT/TDS breakdown update. The
// surface is DRAFT-ONLY (ADR-0039 c5): an ISSUED/CANCELLED invoice is immutable, so a
// non-DRAFT id redirects to the read-only detail page. Server-rendered shell; the
// interactive pieces are client islands that refresh this route after each mutation,
// so the (server-computed) tax preview always reflects the current lines.

interface EditPageProps {
  params: Promise<{ id: string }>;
}

interface JobsListResponse {
  items: JobListItem[];
}

interface TripsListResponse {
  items: TripListItem[];
}

function isoToDay(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export default async function EditInvoicePage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
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

  // Only a DRAFT is editable (ADR-0039 c5). An ISSUED/CANCELLED invoice is
  // read-only — send the operator to the detail page.
  if (invoice.status !== "DRAFT") {
    redirect(`/invoices/${id}`);
  }

  // The customer's jobs (for the provenance picker + build-from-job) and the recent
  // trips (the build-from-job trip picker). Fetched in parallel; a failure other
  // than 401 bubbles to the framework error boundary.
  let jobs: JobListItem[] = [];
  let trips: TripListItem[] = [];
  try {
    const [jobList, tripList] = await Promise.all([
      apiFetch<JobsListResponse>(
        `/api/v1/jobs?customerId=${encodeURIComponent(invoice.customerId)}&sortBy=jobNumber&sortDir=desc&take=200`,
      ),
      apiFetch<TripsListResponse>("/api/v1/trips?sortBy=createdAt&sortDir=desc&take=200"),
    ]);
    jobs = jobList.items;
    trips = tripList.items;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login");
    throw error;
  }

  const jobOptions = jobs.map((j) => ({
    id: j.id,
    jobNumber: j.jobNumber,
    description: j.description,
  }));
  const tripOptions: TripOption[] = trips.map((t) => {
    const day = isoToDay(t.startedAt ?? t.endedAt ?? t.createdAt);
    return {
      id: t.id,
      label: `${t.vehicle.registrationNumber} · ${t.driver.fullName}${day ? ` · ${day}` : ""}`,
    };
  });

  const heading =
    invoice.documentType === "CREDIT_NOTE" ? "Edit credit-note draft" : "Edit invoice draft";

  // The provisional tax preview from the current lines (when a service type is set).
  let figures: InvoiceTaxSummaryFigures | null = null;
  let taxNote: string | null = null;
  if (invoice.serviceType !== null) {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: invoice.lines.map((line) => line.lineAmountPaisa),
      discountPaisa: invoice.discountPaisa,
      serviceType: invoice.serviceType,
    });
    if (preview) figures = preview;
    else taxNote = "Tax breakdown unavailable: the discount exceeds the subtotal.";
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
              <Link href={`/invoices/${invoice.id}`} className="hover:text-text-primary">
                {invoice.number ?? "Draft"}
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">Edit</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">{heading}</h1>
            <p className="text-text-muted text-sm">
              Billing{" "}
              <Link
                href={`/customers/${invoice.customer.id}`}
                className="text-text-secondary underline-offset-2 hover:underline"
              >
                {invoice.customer.name}
              </Link>
              . The customer is fixed for this invoice.
            </p>
          </div>
          <Button asChild>
            <Link href={`/invoices/${invoice.id}`}>Done — review &amp; issue</Link>
          </Button>
        </header>

        {/* Header fields */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Header
          </h2>
          <EditInvoiceHeaderForm
            invoiceId={invoice.id}
            jobs={jobOptions}
            initial={{
              jobId: invoice.jobId ?? "",
              serviceType: invoice.serviceType ?? "",
              discount:
                invoice.discountPaisa !== null ? paisaToRupeesInput(invoice.discountPaisa) : "",
            }}
          />
        </section>

        {/* Lines */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Lines
          </h2>
          <InvoiceLinesSection invoiceId={invoice.id} lines={invoice.lines} />
        </section>

        {/* Build from job */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-1 text-xs font-medium tracking-wide uppercase">
            Build from a job
          </h2>
          <p className="text-text-muted mb-4 text-sm">
            Pick a job and the trips to bill; each becomes a line stamped with the trip’s date.
          </p>
          <BuildFromJobForm invoiceId={invoice.id} jobs={jobOptions} trips={tripOptions} />
        </section>

        {/* Tax preview */}
        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Tax preview
          </h2>
          {figures ? (
            <InvoiceTaxSummary figures={figures} provisional />
          ) : (
            <p className="text-text-secondary text-sm">{taxNote}</p>
          )}
        </section>
      </div>
    </main>
  );
}
