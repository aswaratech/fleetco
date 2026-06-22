import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import { EditServiceScheduleForm } from "./edit-service-schedule-form";
import type { ServiceSchedule } from "../../types";

// Edit service schedule — ADR-0037 B5 (write path). Server-rendered shell (auth
// gate; redirect to /login if absent) wrapping the client-side form. Fetches the
// schedule (404 → notFound) and its owning vehicle (for the read-only
// registration display + the meterType the client-side meter-consistency guard
// needs). The form computes a diff and PATCHes only the changed fields.

interface EditPageProps {
  params: Promise<{ id: string }>;
}

interface VehicleSummary {
  id: string;
  registrationNumber: string;
  meterType: "ODOMETER_KM" | "ENGINE_HOURS" | "BOTH";
}

export default async function EditServiceSchedulePage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let schedule: ServiceSchedule;
  try {
    schedule = await apiFetch<ServiceSchedule>(`/api/v1/service-schedules/${id}`);
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

  // Resolve the owning vehicle for the read-only registration + the meterType
  // guard. A 401 redirects; any other failure leaves `vehicle` null and the form
  // falls back to the raw id (the FK Restrict makes a missing vehicle effectively
  // impossible, so this is defensive).
  let vehicle: VehicleSummary | null = null;
  try {
    vehicle = await apiFetch<VehicleSummary>(
      `/api/v1/vehicles/${encodeURIComponent(schedule.vehicleId)}`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    // Non-401: fall back to the raw id in the form.
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
            <Link href={`/service-schedules/${schedule.id}`} className="hover:text-text-primary">
              {schedule.name}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit service schedule</h1>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditServiceScheduleForm schedule={schedule} vehicle={vehicle} />
        </section>
      </div>
    </main>
  );
}
