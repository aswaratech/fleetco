import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { apiFetch, ApiError } from "@/lib/api";
import { CUSTOMER_STATUS_LABELS } from "@/lib/customers-schema";
import { getServerSession } from "@/lib/session";

import type { Customer } from "../types";
import { DeleteCustomerDialog } from "./delete-customer-dialog";

// Customer detail — iter 15 of the Customers slice. Server-rendered
// shell (auth gate via getServerSession; redirect to /login if
// absent); fetches the customer via apiFetch and surfaces 404 through
// Next.js's notFound() route so /customers/<bogus-id> renders the
// framework's standard not-found page.
//
// Iter 16 wired the Edit / Delete CTAs into the header right-side
// cluster (mirror of the Drivers iter-7 detail-page layout). The
// Delete button opens a confirmation dialog (DeleteCustomerDialog, a
// small client island around shadcn's AlertDialog); the action layer
// (../actions.ts:deleteCustomerAction) issues DELETE and redirects on
// success.
//
// Field layout: a definition list (<dl>) under DESIGN.md §"Data
// display" typography tokens. Two-column on >= sm; stacks on narrow
// viewports. Mirrors apps/web/src/app/drivers/[id]/page.tsx in shape;
// no cross-slice "Recent trips" / "Lifetime stats" sections this iter
// because the Customer aggregate has no inbound FKs yet — the future
// Jobs slice will be the first cross-slice consumer.

interface DetailPageProps {
  params: Promise<{ id: string }>;
}

// formatDate (YYYY-MM-DD without time) is intentionally not declared
// here — iter 15's Customer wire shape has no date-only fields. Iter
// 16's write path may introduce one (e.g., contractStartedAt) at
// which point we mirror the Drivers/Vehicles detail-page formatter.

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function CustomerDetailPage({
  params,
}: DetailPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let customer: Customer;
  try {
    customer = await apiFetch<Customer>(`/api/v1/customers/${id}`);
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
              <Link href="/customers" className="hover:text-text-primary">
                Customers
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">{customer.name}</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">{customer.name}</h1>
            <p className="text-text-muted text-sm">
              {CUSTOMER_STATUS_LABELS[customer.status] ?? customer.status}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href={`/customers/${customer.id}/edit`}>Edit</Link>
            </Button>
            <DeleteCustomerDialog id={customer.id} name={customer.name} />
          </div>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            <DetailRow label="Name" value={customer.name} />
            <DetailRow label="Contact person" value={customer.contactPerson ?? "—"} />
            <DetailRow label="Phone" value={customer.phone} mono />
            <DetailRow label="Email" value={customer.email ?? "—"} mono={Boolean(customer.email)} />
            <DetailRow
              label="PAN number"
              value={customer.panNumber ?? "—"}
              mono={Boolean(customer.panNumber)}
            />
            <DetailRow
              label="Status"
              value={CUSTOMER_STATUS_LABELS[customer.status] ?? customer.status}
            />
            <DetailRow label="Address" value={customer.address ?? "—"} />
            <DetailRow label="Created at" value={formatTimestamp(customer.createdAt)} />
            <DetailRow label="Updated at" value={formatTimestamp(customer.updatedAt)} />
            {/* No `createdById` row — the operator does not need to see
                the actor id, only that the timestamp exists. The
                "who" column lands when iter 16's audit-log surface or
                a future actor-attribution slice needs it. Mirror of
                the Drivers detail page omission. */}
          </dl>
        </section>
      </div>
    </main>
  );
}

interface DetailRowProps {
  label: string;
  // Accept ReactNode so a future cross-slice surface can pass a <Link>
  // (e.g., a "Jobs by this customer" link when the Jobs slice lands).
  // For the iter-15 read path every value is a plain string. Mirror of
  // the widened Drivers / Vehicles detail-page DetailRow.
  value: React.ReactNode;
  mono?: boolean;
  numeric?: boolean;
}

function DetailRow({ label, value, mono, numeric }: DetailRowProps): React.ReactElement {
  // Definition-list row — DESIGN.md §"Data display": Latin numerals,
  // tabular-nums for numeric values, mono for identifiers (phone,
  // email, PAN), default sans for everything else.
  const valueClass = [
    "text-text-primary text-sm",
    mono ? "font-mono" : "",
    numeric ? "tabular-nums" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="space-y-1">
      <dt className="text-text-muted text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
