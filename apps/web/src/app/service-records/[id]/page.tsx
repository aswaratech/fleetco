import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { formatNepaliDate } from "@/lib/nepali-date";
import { formatNpr } from "@/lib/money";
import { getServerSession } from "@/lib/session";
import { formatHours, formatKm } from "@/lib/units";

import { DeleteServiceRecordDialog } from "./delete-service-record-dialog";
import type { ServiceRecord } from "../types";
import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory } from "../../expense-logs/types";

// Service-record detail — ADR-0037 B5. Server-rendered shell (auth gate;
// redirect to /login if absent); fetches the record and surfaces 404 through
// notFound(). The bare record carries only FK ids, so the vehicle registration,
// the schedule name, and the linked expense's amount are each resolved by a
// separate fetch. The COST is read THROUGH the ExpenseLog's amountPaisa via
// formatNpr (ADR-0037 c6) — never a money column on the record.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

interface VehicleSummary {
  id: string;
  registrationNumber: string;
}

interface ScheduleSummary {
  id: string;
  name: string;
}

interface ExpenseSummary {
  id: string;
  amountPaisa: number;
  category: ExpenseCategory;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function ServiceRecordDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let record: ServiceRecord;
  try {
    record = await apiFetch<ServiceRecord>(`/api/v1/service-records/${id}`);
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

  // Resolve the vehicle (registration), the linked schedule (name), and the
  // linked expense (cost) — the latter two only when present. A 401 redirects;
  // any other failure on an enrichment fetch falls back to the raw id / em-dash
  // rather than failing the page the operator already reached.
  let vehicle: VehicleSummary | null = null;
  let schedule: ScheduleSummary | null = null;
  let expense: ExpenseSummary | null = null;
  try {
    [vehicle, schedule, expense] = await Promise.all([
      apiFetch<VehicleSummary>(`/api/v1/vehicles/${encodeURIComponent(record.vehicleId)}`).catch(
        rethrow401,
      ),
      record.serviceScheduleId
        ? apiFetch<ScheduleSummary>(
            `/api/v1/service-schedules/${encodeURIComponent(record.serviceScheduleId)}`,
          ).catch(rethrow401)
        : Promise.resolve(null),
      record.expenseLogId
        ? apiFetch<ExpenseSummary>(
            `/api/v1/expense-logs/${encodeURIComponent(record.expenseLogId)}`,
          ).catch(rethrow401)
        : Promise.resolve(null),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

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
              <Link href="/service-records" className="hover:text-text-primary">
                Service history
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">
                {formatNepaliDate(record.performedAt, { format: "bs" })}
              </span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">
              Service on <NepaliDate iso={record.performedAt} format="bs" />
            </h1>
            <p className="text-text-muted text-sm">
              {vehicle ? (
                <Link
                  href={`/vehicles/${vehicle.id}`}
                  className="hover:text-text-primary font-mono"
                >
                  {vehicle.registrationNumber}
                </Link>
              ) : (
                <span className="font-mono">{record.vehicleId}</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/service-records/${record.id}/edit`}>Edit</Link>
            </Button>
            <DeleteServiceRecordDialog id={record.id} performedAt={record.performedAt} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Service
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow
              label="Vehicle"
              value={
                vehicle ? (
                  <Link
                    href={`/vehicles/${vehicle.id}`}
                    className="text-text-primary hover:text-text-secondary font-mono underline-offset-2 hover:underline"
                  >
                    {vehicle.registrationNumber}
                  </Link>
                ) : (
                  <span className="font-mono">{record.vehicleId}</span>
                )
              }
            />
            <DetailRow label="Performed at" value={<NepaliDate iso={record.performedAt} />} />
            <DetailRow
              label="Schedule"
              value={
                record.serviceScheduleId === null ? (
                  <span className="text-text-muted">Ad-hoc (no schedule)</span>
                ) : (
                  <Link
                    href={`/service-schedules/${record.serviceScheduleId}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    {schedule?.name ?? record.serviceScheduleId}
                  </Link>
                )
              }
            />
            <DetailRow
              label="Cost"
              value={
                record.expenseLogId === null ? (
                  "—"
                ) : (
                  <Link
                    href={`/expense-logs/${record.expenseLogId}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline tabular-nums"
                  >
                    {expense
                      ? `${formatNpr(expense.amountPaisa)} · ${EXPENSE_CATEGORY_LABELS[expense.category]}`
                      : "View expense"}
                  </Link>
                )
              }
            />
            <DetailRow label="Odometer reading" value={formatKm(record.odometerKm)} numeric />
            <DetailRow label="Engine hours" value={formatHours(record.engineHours)} numeric />
            {record.notes ? (
              <DetailRow label="Notes" value={record.notes} className="sm:col-span-2" />
            ) : null}
          </dl>
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(record.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(record.updatedAt)} />
          </dl>
        </section>
      </div>
    </main>
  );
}

// Re-throw an ApiError 401 (so the page's catch redirects to /login) but swallow
// any other enrichment-fetch failure to null, so a missing/forbidden side
// resource degrades to a raw id / em-dash rather than failing the whole page.
function rethrow401(error: unknown): null {
  if (error instanceof ApiError && error.status === 401) {
    throw error;
  }
  return null;
}

interface DetailRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  numeric?: boolean;
  className?: string;
}

function DetailRow({ label, value, mono, numeric, className }: DetailRowProps): React.ReactElement {
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
      <dt className="text-text-muted text-xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
