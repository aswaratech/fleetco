import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import type { DocumentsListResponse } from "@/lib/documents";
import {
  DOCUMENT_CATEGORY_FOR_KIND,
  EXPENSE_CATEGORIES_FOR_KIND,
  isRenewalKind,
  RENEWAL_KIND_LABELS,
  type RenewalKind,
} from "@/lib/renewals";

import { RenewalForm } from "./renewal-form";

// The renew page (ADR-0049 F5, DESIGN.md §"Fleet documents & renewals"):
// entered from the three Renew buttons on the vehicle's Compliance section
// (?kind=BLUEBOOK|INSURANCE|ROUTE_PERMIT; an absent/invalid kind defaults to
// BLUEBOOK). The server shell prefetches the vehicle (404 guard + the
// pre-filled identity fields), the vehicle's documents of the kind's
// matching category (the proof select), and same-vehicle expense logs
// narrowed to the kind's allowed categories (the cost select).

interface VehicleForRenewal {
  id: string;
  registrationNumber: string;
  bluebookNumber: string | null;
  insurer: string | null;
  insurancePolicyNumber: string | null;
  insuranceType: string | null;
  routePermitNumber: string | null;
}

interface ExpenseListItem {
  id: string;
  amountPaisa: number;
  date: string;
  category: string;
  notes: string | null;
}

interface ExpensesListResponse {
  items: ExpenseListItem[];
  total: number;
}

export default async function NewRenewalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const { kind: kindParam } = await searchParams;
  const kind: RenewalKind = isRenewalKind(kindParam) ? kindParam : "BLUEBOOK";

  let vehicle: VehicleForRenewal;
  try {
    vehicle = await apiFetch<VehicleForRenewal>(`/api/v1/vehicles/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login");
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  // The proof-document options: this vehicle's documents of the kind's
  // matching category. Degrades to an empty select on failure.
  let documents: { id: string; title: string }[] = [];
  try {
    const response = await apiFetch<DocumentsListResponse>(
      `/api/v1/documents?vehicleId=${encodeURIComponent(vehicle.id)}&category=${DOCUMENT_CATEGORY_FOR_KIND[kind]}&take=200`,
    );
    documents = response.items.map((item) => ({ id: item.id, title: item.title }));
  } catch {
    // Non-blocking: renewing without a document link stays possible.
  }

  // The cost options: recent same-vehicle expenses in the kind's allowed
  // categories (fetched unfiltered newest-first, narrowed here — the list
  // endpoint takes one category per query and BLUEBOOK allows two).
  let expenses: { id: string; amountPaisa: number; date: string; notes: string | null }[] = [];
  try {
    const allowed = EXPENSE_CATEGORIES_FOR_KIND[kind];
    const response = await apiFetch<ExpensesListResponse>(
      `/api/v1/expense-logs?vehicleId=${encodeURIComponent(vehicle.id)}&sortBy=date&sortDir=desc&take=100`,
    );
    expenses = response.items
      .filter((item) => allowed.includes(item.category))
      .slice(0, 50)
      .map(({ id: expenseId, amountPaisa, date, notes }) => ({
        id: expenseId,
        amountPaisa,
        date,
        notes,
      }));
  } catch {
    // Non-blocking: renewing without a cost link stays possible.
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href="/vehicles" className="hover:text-text-primary">
              Vehicles
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/vehicles/${vehicle.id}`} className="hover:text-text-primary font-mono">
              {vehicle.registrationNumber}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Renew</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">
            Renew {RENEWAL_KIND_LABELS[kind].toLowerCase()}
          </h1>
          <p className="text-text-muted text-sm">
            Records the renewal (old → new expiry, the paper, the cost) and updates{" "}
            <span className="font-mono">{vehicle.registrationNumber}</span> in one step. The
            reminder re-arms on the new date automatically.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <RenewalForm
            vehicleId={vehicle.id}
            kind={kind}
            current={{
              bluebookNumber: vehicle.bluebookNumber,
              insurer: vehicle.insurer,
              insurancePolicyNumber: vehicle.insurancePolicyNumber,
              insuranceType: vehicle.insuranceType,
              routePermitNumber: vehicle.routePermitNumber,
            }}
            documents={documents}
            expenses={expenses}
          />
        </section>
      </div>
    </main>
  );
}
