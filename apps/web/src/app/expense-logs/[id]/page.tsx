import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { formatNpr } from "@/lib/money";
import { formatNepaliDate } from "@/lib/nepali-date";
import { getServerSession } from "@/lib/session";

import { EXPENSE_CATEGORY_LABELS, type ExpenseCategory, type ExpenseLogDetail } from "../types";
import { DeleteExpenseLogDialog } from "./delete-expense-log-dialog";

// Expense log detail — iter 21 of the Expense-logs slice (read path).
// Server-rendered shell (auth gate via getServerSession; redirect to
// /login if absent); fetches the expense log via apiFetch and surfaces
// 404 through Next.js's notFound() route. Mirrors apps/web/src/app/
// fuel-logs/[id]/page.tsx in shape.
//
// The detail renders the nested Vehicle (when present — `vehicleId` is
// nullable on this aggregate) and the nested Trip when set (the FK is
// nullable). The vehicle registration number links back to
// /vehicles/<id> and the trip id (when present) links to /trips/<id>
// so an operator can pivot to the related records — the same cross-
// slice pivot the Fuel logs / Trips / Jobs detail pages use. Iter 22
// adds Edit / Delete CTAs (no write path this iter).
//
// When `vehicle` is null (a vehicle-agnostic expense like the company's
// quarterly insurance premium), the Vehicle section is replaced by a
// muted "Not vehicle-attributable" notice so the operator sees the
// row's intentional shape rather than a missing section.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function ExpenseLogDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let expense: ExpenseLogDetail;
  try {
    expense = await apiFetch<ExpenseLogDetail>(`/api/v1/expense-logs/${id}`);
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

  const categoryLabel =
    EXPENSE_CATEGORY_LABELS[expense.category as ExpenseCategory] ?? expense.category;

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
              <Link href="/expense-logs" className="hover:text-text-primary">
                Expense logs
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary tabular-nums">
                <NepaliDate iso={expense.date} format="bs" />
              </span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold tabular-nums">
              <NepaliDate iso={expense.date} format="bs" />
            </h1>
            <p className="text-text-muted text-sm">
              {expense.vehicle ? (
                <span className="font-mono">{expense.vehicle.registrationNumber}</span>
              ) : (
                <span className="italic">Not vehicle-attributable</span>
              )}{" "}
              · {categoryLabel} · {formatNpr(expense.amountPaisa)}
            </p>
          </div>
          {/* Edit + Delete CTAs (iter 22). Mirror of the Fuel logs /
              Jobs / Customers / Drivers / Vehicles header cluster.
              The Delete button opens a confirmation dialog (client
              island); Edit links to /expense-logs/<id>/edit. */}
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/expense-logs/${expense.id}/edit`}>Edit</Link>
            </Button>
            <DeleteExpenseLogDialog
              id={expense.id}
              dateLabel={formatNepaliDate(expense.date, { format: "bs" })}
            />
          </div>
        </header>

        {expense.vehicle ? (
          <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
            <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
              Vehicle
            </h2>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <DetailRow
                label="Registration"
                value={
                  <Link
                    href={`/vehicles/${expense.vehicle.id}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    {expense.vehicle.registrationNumber}
                  </Link>
                }
                mono
              />
              <DetailRow label="Kind" value={expense.vehicle.kind} />
              <DetailRow
                label="Make / model"
                value={`${expense.vehicle.make} ${expense.vehicle.model}`}
              />
              <DetailRow label="Year" value={String(expense.vehicle.year)} numeric />
            </dl>
          </section>
        ) : (
          <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
            <h2 className="text-text-muted mb-2 text-xs font-medium tracking-wide uppercase">
              Vehicle
            </h2>
            <p className="text-text-secondary text-sm">
              Not vehicle-attributable. This expense is logged at the company level rather than
              against a specific vehicle (e.g. office stationery, the quarterly insurance premium).
            </p>
          </section>
        )}

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Expense
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Date" value={<NepaliDate iso={expense.date} />} numeric />
            <DetailRow label="Category" value={categoryLabel} />
            <DetailRow label="Amount" value={formatNpr(expense.amountPaisa)} numeric />
            <DetailRow label="Vendor" value={expense.vendor ?? "—"} />
            <DetailRow label="Receipt number" value={expense.receiptNumber ?? "—"} mono />
            <DetailRow label="Notes" value={expense.notes ?? "—"} className="sm:col-span-2" />
          </dl>
        </section>

        {expense.trip ? (
          <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
            <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
              Trip
            </h2>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
              <DetailRow
                label="Trip"
                value={
                  <Link
                    href={`/trips/${expense.trip.id}`}
                    className="text-text-primary hover:text-text-secondary underline-offset-2 hover:underline"
                  >
                    View trip
                  </Link>
                }
              />
              <DetailRow label="Status" value={expense.trip.status} />
            </dl>
          </section>
        ) : null}

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <h2 className="text-text-muted mb-4 text-xs font-medium tracking-wide uppercase">
            Audit
          </h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Created at" value={formatTimestamp(expense.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(expense.updatedAt)} />
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
  // identifiers (vehicle registration, receipt number), tabular-nums
  // for numeric, default sans otherwise. Accepts a ReactNode so the
  // vehicle registration and trip link can be <Link>s. Mirror of the
  // Fuel logs / Jobs / Trips / Customers detail-page DetailRow.
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
