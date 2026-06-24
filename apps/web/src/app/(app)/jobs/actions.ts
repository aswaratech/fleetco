"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateJobFormSchema,
  UpdateJobFormSchema,
  type CreateJobFormValues,
  type UpdateJobFormValues,
} from "@/lib/jobs-schema";

// Server actions for the Jobs write path — create, update, delete. All
// three call apiFetch from the server context (cookies forward
// automatically) and reshape API errors into a structured result the
// client can render inline. Success paths use Next.js's redirect, which
// throws NEXT_REDIRECT and is caught by the framework as a navigation,
// NOT as a real error.
//
// Mirror of apps/web/src/app/customers/actions.ts in shape, conventions,
// and error model. Differences vs Customers:
//   - the create surface accepts a customerId (picker) but rejects
//     jobNumber from the wire entirely (server-generated, immutable);
//   - the update surface forbids customerId AND jobNumber on the wire
//     (both immutable; the API's .strict() rejects them);
//   - the conflict field token is "jobNumber" for the rare jobNumber-
//     uniqueness 409 (effectively unreachable in practice — the API's
//     create loop retries up to 3 times — but defensively handled);
//   - the update surface additionally surfaces a P2003-stale-customerId
//     400, although the wire-immutability of customerId on PATCH means
//     this branch is currently dead code; we keep the generic 400 path.

export interface ActionError {
  ok: false;
  message: string;
  // Status code so the client can distinguish validation errors (400)
  // from conflicts (409) from auth failures (401) from a customer-not-
  // found 400 on create (the API's BadRequestException from the P2003
  // path), even though the user-facing message body is the same string
  // today.
  status: number;
  // Optional field path so the create form can surface a duplicate-
  // jobNumber 409 inline (although in practice unreachable — see the
  // controller's remapJobNumberConflict JSDoc), or a customer-picker
  // error from the create form when the API reports a stale customerId.
  field?: string;
}

// createJobAction — POSTs a new job. The client form gives us the full
// create payload (CreateJobFormValues); we re-validate server-side
// (defense in depth — a determined attacker could submit a malformed
// payload directly), then POST. On success the function calls
// redirect("/jobs/<id>") (back to the new job's detail page, not the
// list — matches the Customers create flow's mental model that "after
// you create something you want to look at it") which throws
// NEXT_REDIRECT; the client form treats a thrown NEXT_REDIRECT as the
// success path. On failure, returns a structured error so the client
// renders the message inline.
//
// 400 with the API's `Customer <id> does not exist.` body surfaces as
// `field: "customerId"` so the form can highlight the picker. 409 on
// jobNumber-uniqueness collision surfaces as `field: "jobNumber"`
// (effectively unreachable, defensively handled per the API's
// remapJobNumberConflict).
export async function createJobAction(values: CreateJobFormValues): Promise<ActionError | never> {
  const parsed = CreateJobFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Build the wire payload. Optional text + date fields are omitted
  // when blank so the API does not receive an empty string (which the
  // API's schema rejects). The status field is always sent — the form
  // renders a select that always has a value. The customerId is always
  // sent (the schema requires it).
  const body: Record<string, unknown> = {
    customerId: parsed.data.customerId,
    description: parsed.data.description,
    status: parsed.data.status,
  };
  if (parsed.data.scheduledStartDate && parsed.data.scheduledStartDate.length > 0) {
    body.scheduledStartDate = parsed.data.scheduledStartDate;
  }
  if (parsed.data.scheduledEndDate && parsed.data.scheduledEndDate.length > 0) {
    body.scheduledEndDate = parsed.data.scheduledEndDate;
  }
  if (parsed.data.actualStartDate && parsed.data.actualStartDate.length > 0) {
    body.actualStartDate = parsed.data.actualStartDate;
  }
  if (parsed.data.actualEndDate && parsed.data.actualEndDate.length > 0) {
    body.actualEndDate = parsed.data.actualEndDate;
  }
  if (parsed.data.notes && parsed.data.notes.length > 0) {
    body.notes = parsed.data.notes;
  }

  // The API returns the created JobDetail (with the nested customer);
  // we narrow to the id so we can redirect to the detail page.
  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/jobs", { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      // 400: either a schema rejection or the P2003 stale-customerId
      // branch. Distinguish by looking for the API's customer-not-
      // found phrasing so the form can highlight the customer picker.
      if (error.status === 400 && /customer .* does not exist/i.test(error.message)) {
        return { ok: false, message: error.message, status: 400, field: "customerId" };
      }
      // 409 only fires on jobNumber-uniqueness exhaustion (defensive;
      // effectively unreachable per the API's retry loop).
      const field = error.status === 409 ? "jobNumber" : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/jobs");
  redirect(`/jobs/${created.id}`);
}

// updateJobAction — patches only the fields that actually changed vs.
// the user's initial form values. The caller (edit-job-form) computes
// that diff client-side before invoking this action, so the payload
// never re-sends a field the user didn't touch. See DESIGN.md §"Inputs
// and forms" "Diff-against-initial-values for PATCH" for the project-
// wide pattern.
//
// customerId and jobNumber are intentionally NOT in UpdateJobFormValues
// — both are immutable; the API's .strict() rejects them on PATCH and
// the edit form does not render either as editable.
//
// Returns ActionError on failure; throws NEXT_REDIRECT on success.
export async function updateJobAction(
  id: string,
  changedFields: Partial<UpdateJobFormValues>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateJobFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Translate empty-string optional fields into `null` when the field
  // is nullable on the wire (the four dates, notes). The edit form
  // represents a cleared input as an empty string; the API's schema
  // rejects empty strings but accepts `null` as the explicit "clear"
  // signal that the service-layer hasOwnProperty branch consumes.
  // `description` and `status` stay as-is (description is required;
  // status is an enum select that always has a value).
  const wirePayload: Record<string, unknown> = { ...parsed.data };
  for (const key of [
    "scheduledStartDate",
    "scheduledEndDate",
    "actualStartDate",
    "actualEndDate",
    "notes",
  ] as const) {
    if (wirePayload[key] === "") {
      wirePayload[key] = null;
    }
  }
  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/jobs/${id}`, {
      method: "PATCH",
      json: wirePayload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // 409 (jobNumber-uniqueness) is unreachable on PATCH (jobNumber
      // is not in the schema). Kept here for symmetry with the create
      // path; the field token would never be set in practice.
      const field = error.status === 409 ? "jobNumber" : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  redirect(`/jobs/${id}`);
}

// deleteJobAction — issues DELETE /api/v1/jobs/:id. Success (HTTP 204)
// revalidates the list and redirects back to it. 404 is surfaced inline
// (the row may have been deleted by another session between the dialog
// opening and the confirm click). No 409 today — no inbound FKs to Job
// yet (a future Trip→Job FK adds one); when it does, the message will
// surface verbatim through this branch the same way the Customer delete
// dialog handles its iter-18 Jobs reference.
export async function deleteJobAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/jobs/${id}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/jobs");
  redirect("/jobs");
}
