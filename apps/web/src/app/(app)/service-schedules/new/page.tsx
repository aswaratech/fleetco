import Link from "next/link";
import { redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import {
  CreateServiceScheduleForm,
  type ScheduleVehicleOption,
} from "./create-service-schedule-form";

// New service schedule — ADR-0037 B5 (write path). Server-rendered shell (auth
// gate via getServerSession; redirect to /login if absent) wrapping the
// client-side form. The form calls createServiceScheduleAction at ../actions.ts
// which POSTs to the API and redirects to /service-schedules/<id> on success.
//
// The shell pre-fetches active vehicles for the required picker, carrying each
// vehicle's meterType so the form can give immediate meter-consistency feedback
// (ADR-0037 c3). Capped at the API's LIST_TAKE_MAX (200). Layout mirrors
// apps/web/src/app/fuel-logs/new/page.tsx.

interface VehicleRow {
  id: string;
  registrationNumber: string;
  meterType: "ODOMETER_KM" | "ENGINE_HOURS" | "BOTH";
}

interface VehiclesListResponse {
  items: VehicleRow[];
  total: number;
  skip: number;
  take: number;
}

export default async function NewServiceSchedulePage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let vehicles: ScheduleVehicleOption[] = [];
  try {
    const response = await apiFetch<VehiclesListResponse>(
      "/api/v1/vehicles?status=ACTIVE&sortBy=registrationNumber&sortDir=asc&take=200",
    );
    vehicles = response.items.map((v) => ({
      id: v.id,
      registrationNumber: v.registrationNumber,
      meterType: v.meterType,
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
            <Link href="/service-schedules" className="hover:text-text-primary">
              Service schedules
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">New</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">New service schedule</h1>
          <p className="text-text-muted text-sm">
            Define a recurring maintenance interval for a vehicle. &ldquo;Next due&rdquo; is derived
            from the interval and the last-service anchor.
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
                , then come back here to define a schedule.
              </p>
            </div>
          ) : (
            <CreateServiceScheduleForm vehicles={vehicles} />
          )}
        </section>
      </div>
    </main>
  );
}
