import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { formatNepaliDate } from "@/lib/nepali-date";
import { getServerSession } from "@/lib/session";
import type { ExpenseLogListItem } from "../../../expense-logs/types";

import {
  EditServiceRecordForm,
  type EditRecordExpenseOption,
  type EditRecordScheduleOption,
} from "./edit-service-record-form";
import type { ServiceRecord } from "../../types";

// Edit service record — ADR-0037 B5 (write path). Server-rendered shell (auth
// gate; redirect to /login if absent) wrapping the client-side form. Fetches the
// record (404 → notFound), then — since vehicleId is immutable — the picker
// option sets ALREADY scoped to the record's vehicle: the vehicle's schedules
// (all statuses, so a currently-linked INACTIVE schedule still shows) and its
// MAINTENANCE + REPAIR expenses (two fetches, the API's category filter being a
// single enum).

interface EditPageProps {
  params: Promise<{ id: string }>;
}

interface VehicleSummary {
  id: string;
  registrationNumber: string;
}

interface SchedulesListResponse {
  items: { id: string; name: string }[];
  total: number;
}

interface ExpensesListResponse {
  items: ExpenseLogListItem[];
  total: number;
}

export default async function EditServiceRecordPage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
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

  const v = encodeURIComponent(record.vehicleId);
  let vehicleRegistration = record.vehicleId;
  let schedules: EditRecordScheduleOption[] = [];
  let expenses: EditRecordExpenseOption[] = [];
  try {
    const [vehicle, schedulesRes, maintenanceRes, repairRes] = await Promise.all([
      apiFetch<VehicleSummary>(`/api/v1/vehicles/${v}`).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) throw error;
        return null;
      }),
      apiFetch<SchedulesListResponse>(
        `/api/v1/service-schedules?vehicleId=${v}&sortBy=name&sortDir=asc&take=200`,
      ),
      apiFetch<ExpensesListResponse>(
        `/api/v1/expense-logs?vehicleId=${v}&category=MAINTENANCE&sortBy=date&sortDir=desc&take=200`,
      ),
      apiFetch<ExpensesListResponse>(
        `/api/v1/expense-logs?vehicleId=${v}&category=REPAIR&sortBy=date&sortDir=desc&take=200`,
      ),
    ]);
    if (vehicle) vehicleRegistration = vehicle.registrationNumber;
    schedules = schedulesRes.items;
    expenses = [...maintenanceRes.items, ...repairRes.items].map((e) => ({
      id: e.id,
      amountPaisa: e.amountPaisa,
      date: e.date,
      category: e.category,
    }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
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
            <Link href="/service-records" className="hover:text-text-primary">
              Service history
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/service-records/${record.id}`} className="hover:text-text-primary">
              {formatNepaliDate(record.performedAt, { format: "bs" })}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit service record</h1>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditServiceRecordForm
            record={record}
            vehicleRegistration={vehicleRegistration}
            schedules={schedules}
            expenses={expenses}
          />
        </section>
      </div>
    </main>
  );
}
