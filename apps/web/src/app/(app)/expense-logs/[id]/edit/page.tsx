import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";

import type { ExpenseLogDetail } from "../../types";
import { EditExpenseLogForm } from "./edit-expense-log-form";

// Edit expense log — iter 22 of the Expense-logs slice (write path).
// Server-rendered shell (auth gate, page chrome) wrapping the client-
// side form. The form is pre-filled from the fetched expense log and
// submits via the server action at /expense-logs/actions.ts
// (updateExpenseLogAction), which performs the PATCH. On success the
// action revalidates and redirects to /expense-logs/<id> (back to the
// detail page).
//
// Layout mirrors apps/web/src/app/fuel-logs/[id]/edit/page.tsx and
// follows DESIGN.md §"Page header" and §"Inputs and forms".
//
// `vehicleId` is immutable per the API's schema (the PATCH endpoint's
// .strict() rejects it). The edit form does NOT render a vehicle
// picker; the vehicle binding is shown as static text in the form
// header (mirror of how the Fuel logs edit form surfaces it). To
// change the vehicle binding the operator must delete + recreate.
// `tripId` is mutable, BUT the trip picker is only rendered when the
// expense already has a vehicleId — pairing a vehicle-agnostic
// expense with a trip is a degenerate case and we'd rather force the
// operator to recreate the expense against a vehicle first.
//
// To populate the (optional) trip picker, the shell fetches the list
// of recent trips for this vehicle (when the expense has a vehicleId)
// so the form can let the operator re-pair or unpair the expense.

interface TripOption {
  id: string;
  vehicleId: string;
  status: string;
  vehicle: { id: string; registrationNumber: string };
}

interface TripsListResponse {
  items: TripOption[];
  total: number;
  skip: number;
  take: number;
}

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditExpenseLogPage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
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

  // Fetch trips for this vehicle so the trip picker is scoped. Only
  // useful when the expense has a vehicleId — a vehicle-agnostic
  // expense's trip picker is suppressed entirely. Sorted by
  // startedAt desc; same cap as the create shell.
  let trips: TripOption[] = [];
  if (expense.vehicleId) {
    try {
      const response = await apiFetch<TripsListResponse>(
        `/api/v1/trips?vehicleId=${expense.vehicleId}&sortBy=startedAt&sortDir=desc&take=200`,
      );
      trips = response.items;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        redirect("/login");
      }
      throw error;
    }
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
            <Link href="/expense-logs" className="hover:text-text-primary">
              Expense logs
            </Link>
            <span aria-hidden="true"> › </span>
            <Link
              href={`/expense-logs/${expense.id}`}
              className="hover:text-text-primary tabular-nums"
            >
              {expense.date.slice(0, 10)}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit expense log</h1>
          <p className="text-text-muted text-sm">
            The vehicle binding is fixed. Only changed fields are sent to the API. To re-attribute
            this expense to a different vehicle, delete and recreate it.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditExpenseLogForm expense={expense} trips={trips} />
        </section>
      </div>
    </main>
  );
}
