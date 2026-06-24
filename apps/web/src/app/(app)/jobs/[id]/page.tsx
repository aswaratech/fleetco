import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { CUSTOMER_STATUS_LABELS } from "@/lib/customers-schema";
import { getServerSession } from "@/lib/session";

import { DeleteJobDialog } from "./delete-job-dialog";
import { JOB_STATUS_LABELS, type JobDetail } from "../types";

// Job detail — iter 17 of the Jobs slice (read path). Server-rendered
// shell (auth gate via getServerSession; redirect to /login if absent);
// fetches the job via apiFetch and surfaces 404 through Next.js's
// notFound() route. Mirrors apps/web/src/app/customers/[id]/page.tsx
// and the Trips detail page in shape.
//
// The detail renders the full nested Customer (JobDetail's
// DETAIL_INCLUDE on the API); the customer name links back to
// /customers/<id> so an operator can pivot to the master record — the
// same cross-slice pivot the Trips detail page uses for its vehicle /
// driver. Iter 18 adds Edit / Cancel CTAs (no write path this iter).
// A future iter (when Trips gains a jobId FK) adds a "Trips on this
// job" section here.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function JobDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let job: JobDetail;
  try {
    job = await apiFetch<JobDetail>(`/api/v1/jobs/${id}`);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        redirect("/login");
      }
      if (error.status === 404) {
        notFound();
      }
    }
    throw error;
  }

  const statusLabel = JOB_STATUS_LABELS[job.status] ?? job.status;

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
              <Link href="/" className="hover:text-text-primary">
                FleetCo
              </Link>
              <span aria-hidden="true"> › </span>
              <Link href="/jobs" className="hover:text-text-primary">
                Jobs
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary font-mono">{job.jobNumber}</span>
            </nav>
            <h1 className="text-text-primary font-mono text-2xl font-semibold">{job.jobNumber}</h1>
            <p className="text-text-muted text-sm">
              {job.customer.name} · {statusLabel}
            </p>
          </div>
          {/* Edit + Delete CTAs land with the iter-18 write path —
              mirror of the Customers / Drivers / Vehicles header
              cluster. The dialog is its own client island so the page
              stays a Server Component. */}
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/jobs/${job.id}/edit`}>Edit</Link>
            </Button>
            <DeleteJobDialog id={job.id} jobNumber={job.jobNumber} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">
            Customer
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Name"
              value={
                <Link
                  href={`/customers/${job.customer.id}`}
                  className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                >
                  {job.customer.name}
                </Link>
              }
            />
            <DetailRow
              label="Customer status"
              value={CUSTOMER_STATUS_LABELS[job.customer.status] ?? job.customer.status}
            />
            <DetailRow label="Contact person" value={job.customer.contactPerson ?? "—"} />
            <DetailRow label="Phone" value={job.customer.phone} mono />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">Job</h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Job number" value={job.jobNumber} mono />
            <DetailRow label="Status" value={statusLabel} />
            <DetailRow label="Description" value={job.description} className="sm:col-span-2" />
            <DetailRow
              label="Scheduled start"
              value={<NepaliDate iso={job.scheduledStartDate} />}
            />
            <DetailRow label="Scheduled end" value={<NepaliDate iso={job.scheduledEndDate} />} />
            <DetailRow label="Actual start" value={<NepaliDate iso={job.actualStartDate} />} />
            <DetailRow label="Actual end" value={<NepaliDate iso={job.actualEndDate} />} />
            <DetailRow label="Notes" value={job.notes ?? "—"} className="sm:col-span-2" />
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium uppercase tracking-wide">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(job.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(job.updatedAt)} />
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
  numeric?: boolean;
  className?: string;
}

function DetailRow({ label, value, mono, numeric, className }: DetailRowProps): React.ReactElement {
  // Definition-list row — DESIGN.md §"Data display": mono for
  // identifiers (job number, phone), tabular-nums for numeric, default
  // sans otherwise. Accepts a ReactNode so the customer name can be a
  // <Link>. Mirror of the Trips / Customers detail-page DetailRow.
  const valueClass = [
    "text-text-primary text-sm",
    mono ? "font-mono" : "",
    numeric ? "tabular-nums" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const wrapperClass = ["space-y-1", className].filter(Boolean).join(" ");
  return (
    <div className={wrapperClass}>
      <dt className="text-text-muted text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
