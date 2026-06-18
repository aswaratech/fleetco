import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";
import type { ExpenseLogListItem } from "../../expense-logs/types";

import {
  CreateServiceRecordForm,
  type RecordExpenseOption,
  type RecordScheduleOption,
  type RecordVehicleOption,
} from "./create-service-record-form";

// New service record — ADR-0037 B5 (write path). Server-rendered shell (auth
// gate; redirect to /login if absent) wrapping the client-side form, which calls
// createServiceRecordAction and redirects to /service-records/<id> on success.
//
// The shell pre-fetches the three picker datasets:
//   - active vehicles (the required picker),
//   - active service schedules (filtered client-side to the chosen vehicle),
//   - MAINTENANCE + REPAIR expense logs (the cost-link picker; the API's category
//     filter is a SINGLE enum, so the two categories are fetched separately and
//     merged), filtered client-side to the chosen vehicle.
// Each is capped at the API's LIST_TAKE_MAX (200).
//
// PREFILL: the schedule detail page's "Record a service" deep-link carries
// ?vehicleId=&serviceScheduleId=, so a service recorded from a schedule lands
// with both pickers pre-selected. Unknown / absent params fall back to "".

interface VehiclesListResponse {
  items: { id: string; registrationNumber: string }[];
  total: number;
}

interface SchedulesListResponse {
  items: { id: string; name: string; vehicleId: string }[];
  total: number;
}

interface ExpensesListResponse {
  items: ExpenseLogListItem[];
  total: number;
}

interface NewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value[0] ?? "";
  return value;
}

export default async function NewServiceRecordPage({
  searchParams,
}: NewPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const params = await searchParams;
  const defaultVehicleId = single(params.vehicleId);
  const defaultScheduleId = single(params.serviceScheduleId);

  let vehicles: RecordVehicleOption[] = [];
  let schedules: RecordScheduleOption[] = [];
  let expenses: RecordExpenseOption[] = [];
  try {
    const [vehiclesRes, schedulesRes, maintenanceRes, repairRes] = await Promise.all([
      apiFetch<VehiclesListResponse>(
        "/api/v1/vehicles?status=ACTIVE&sortBy=registrationNumber&sortDir=asc&take=200",
      ),
      apiFetch<SchedulesListResponse>(
        "/api/v1/service-schedules?status=ACTIVE&sortBy=name&sortDir=asc&take=200",
      ),
      apiFetch<ExpensesListResponse>(
        "/api/v1/expense-logs?category=MAINTENANCE&sortBy=date&sortDir=desc&take=200",
      ),
      apiFetch<ExpensesListResponse>(
        "/api/v1/expense-logs?category=REPAIR&sortBy=date&sortDir=desc&take=200",
      ),
    ]);
    vehicles = vehiclesRes.items;
    schedules = schedulesRes.items;
    expenses = [...maintenanceRes.items, ...repairRes.items].map((e) => ({
      id: e.id,
      vehicleId: e.vehicleId,
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
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Record a service</h1>
          <p className="text-text-muted text-sm">
            Record a completed service. Link it to a schedule to advance that schedule&apos;s
            &ldquo;next due&rdquo;, and to a maintenance / repair expense to attach its cost.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          {vehicles.length === 0 ? (
            <div className="text-text-secondary space-y-3 text-sm">
              <p>No active vehicles on file.</p>
              <p>
                <Link
                  href="/vehicles/new"
                  className="text-text-primary hover:text-text-secondary underline underline-offset-4"
                >
                  Register a vehicle first
                </Link>
                , then come back here to record a service.
              </p>
            </div>
          ) : (
            <CreateServiceRecordForm
              vehicles={vehicles}
              schedules={schedules}
              expenses={expenses}
              defaultVehicleId={defaultVehicleId}
              defaultScheduleId={defaultScheduleId}
            />
          )}
        </section>
      </div>
    </main>
  );
}
