import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

import type { JobDetail } from "../../types";
import { EditJobForm } from "./edit-job-form";

// Edit job — iter 18 of the Jobs slice (write path). Server-rendered
// shell (auth gate, page chrome) wrapping the client-side form. The
// form is pre-filled from the fetched job and submits via the server
// action at /jobs/actions.ts (updateJobAction), which performs the
// PATCH. On success the action revalidates and redirects to /jobs/<id>
// (back to the detail page, NOT the list — same as Customers /
// Drivers).
//
// Layout mirrors apps/web/src/app/customers/[id]/edit/page.tsx and
// follows DESIGN.md §"Page header" and §"Inputs and forms".
//
// `customerId` and `jobNumber` are immutable per the API's schema (the
// PATCH endpoint's .strict() rejects both). The edit form renders both
// as read-only display rows so the operator sees what they are without
// being able to change them.

interface EditPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditJobPage({ params }: EditPageProps): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  const { id } = await params;

  let job: JobDetail;
  try {
    job = await apiFetch<JobDetail>(`/api/v1/jobs/${id}`);
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
            <Link href="/jobs" className="hover:text-text-primary">
              Jobs
            </Link>
            <span aria-hidden="true"> › </span>
            <Link href={`/jobs/${job.id}`} className="hover:text-text-primary font-mono">
              {job.jobNumber}
            </Link>
            <span aria-hidden="true"> › </span>
            <span className="text-text-secondary">Edit</span>
          </nav>
          <h1 className="text-text-primary text-2xl font-semibold">Edit job</h1>
          <p className="text-text-muted text-sm">
            The job number and customer are fixed. Only changed fields are sent to the API. Clear an
            optional field by emptying its input; the change saves as no value on file.
          </p>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm">
          <EditJobForm job={job} />
        </section>
      </div>
    </main>
  );
}
