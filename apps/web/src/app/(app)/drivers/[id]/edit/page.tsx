import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import type { Driver } from "../../types";
import { EditDriverForm } from "./edit-driver-form";

// Edit driver — iter 7 of the Drivers slice. Server-rendered shell
// (auth gate, page chrome) wrapping the client-side form. The form is
// pre-filled from the fetched driver and submits via the server action
// at /drivers/actions.ts (updateDriverAction), which performs the
// PATCH. On success the action revalidates and redirects to /drivers.
//
// Layout mirrors apps/web/src/app/vehicles/[id]/edit/page.tsx and
// follows DESIGN.md §"Page header" and §"Inputs and forms".

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditDriverPage({
  params,
}: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let driver: Driver;
  try {
    driver = await apiFetch<Driver>(`/api/v1/drivers/${id}`);
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
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <header className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
            <Link href="/" className="hover:text-text-primary">
              FleetCo
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href="/drivers" className="hover:text-text-primary">
              Drivers
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/drivers/${driver.id}`} className="hover:text-text-primary">
              {driver.fullName}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit driver</h1>
          <p className="text-text-muted text-sm">
            Only changed fields are sent to the API. Status changes into Terminated auto-set the
            termination date; status changes out of Terminated clear it.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditDriverForm driver={driver} />
        </section>
      </div>
    </main>
  );
}
