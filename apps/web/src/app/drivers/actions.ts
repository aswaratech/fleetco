"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateDriverFormSchema,
  UpdateDriverFormSchema,
  type CreateDriverFormValues,
  type UpdateDriverFormValues,
} from "@/lib/drivers-schema";

// Server actions for the Drivers write path — create, update, delete.
// All three call apiFetch from the server context (cookies forward
// automatically) and reshape API errors into a structured result the
// client can render inline. Success paths use Next.js's redirect,
// which throws NEXT_REDIRECT and is caught by the framework as a
// navigation, NOT as a real error.
//
// Layout mirrors apps/web/src/app/vehicles/new/actions.ts and
// apps/web/src/app/vehicles/[id]/actions.ts; the Drivers slice
// collapses both into one file (drivers/actions.ts) per the iter-7
// kickoff so the create + update + delete server actions live next to
// each other rather than being split across page directories. Both
// layouts are valid in Next.js's App Router; co-locating reads more
// naturally for the small Drivers surface.

export interface ActionError {
  ok: false;
  message: string;
  // Status code so the client can distinguish validation errors (400)
  // from conflicts (409) from auth failures (401), even though the
  // user-facing message body is the same string today.
  status: number;
  // Optional field path so the create form can surface a duplicate-
  // licenseNumber 409 inline on the licenseNumber input rather than
  // as a generic banner. Vehicles does not use this today — the
  // Drivers slice introduces it because the kickoff explicitly calls
  // for "409 surfaces as a field-level error".
  field?: string;
}

// createDriverAction — POSTs a new driver. The client form gives us
// the full create payload (CreateDriverFormValues); we re-validate
// server-side (the resolver runs in the browser; a determined attacker
// could submit a malformed payload directly), then POST. On success
// the function calls redirect("/drivers") which throws NEXT_REDIRECT;
// the client form treats a thrown NEXT_REDIRECT as the success path.
// On failure, returns a structured error so the client renders the
// message inline.
//
// Duplicate licenseNumber → API returns 409. The runbook
// (docs/runbook/api-error-mapping.md) commits to P2002 → 409 with the
// offending field named in the message body; we set `field:
// "licenseNumber"` on the returned ActionError so the form can show
// the message under the right input.
export async function createDriverAction(
  values: CreateDriverFormValues,
): Promise<ActionError | never> {
  const parsed = CreateDriverFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Build the wire payload. `dateOfBirth` is omitted when blank so the
  // API does not receive an empty string (which its DateInput would
  // reject as 400). All other fields are required by the create form.
  const body: Record<string, unknown> = {
    fullName: parsed.data.fullName,
    licenseNumber: parsed.data.licenseNumber,
    licenseClass: parsed.data.licenseClass,
    phone: parsed.data.phone,
    hiredAt: parsed.data.hiredAt,
    licenseExpiresAt: parsed.data.licenseExpiresAt,
    status: parsed.data.status,
  };
  if (parsed.data.dateOfBirth && parsed.data.dateOfBirth.length > 0) {
    body.dateOfBirth = parsed.data.dateOfBirth;
  }

  try {
    await apiFetch<unknown>("/api/v1/drivers", { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      // 409 only happens for duplicate licenseNumber today (Driver's
      // only unique constraint). When Trips lands and adds new unique
      // constraints, this branch will need to inspect the message to
      // pick the right field path; for now naming the field directly
      // is correct.
      const field = error.status === 409 ? "licenseNumber" : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/drivers");
  redirect("/drivers");
}

// updateDriverAction — patches only the fields that actually changed
// vs. the user's initial form values. The caller (edit-driver-form)
// computes that diff client-side before invoking this action, so the
// payload never re-sends a status field the user didn't touch. This
// matters because the API's terminated-transition rule
// (DriversService.update) keys off status changes: a stale status
// resend would not trigger the rule but a deliberate change to the
// same value WOULD trigger it on the server side, which is the wrong
// behavior. See DESIGN.md §"Inputs and forms" "Diff-against-initial-
// values for PATCH" for the project-wide pattern.
//
// Returns ActionError on failure; throws NEXT_REDIRECT on success.
export async function updateDriverAction(
  id: string,
  changedFields: Partial<UpdateDriverFormValues>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateDriverFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Strip the empty-string dateOfBirth case the same way the create
  // path does. (The form lets a user clear the DOB by emptying the
  // input; sending `dateOfBirth: ""` would 400 the API. To clear an
  // existing DOB the form would need to send `null` explicitly — see
  // the schema's `.nullable()` on the API side — which the iter-7 UI
  // does not currently expose; a future "Clear DOB" affordance would
  // wire to that path.)
  const wirePayload: Record<string, unknown> = { ...parsed.data };
  if (wirePayload.dateOfBirth === "") {
    delete wirePayload.dateOfBirth;
  }
  // If after the strip nothing remains, treat as no-op the same as the
  // earlier zero-key check.
  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/drivers/${id}`, {
      method: "PATCH",
      json: wirePayload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const field = error.status === 409 ? "licenseNumber" : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/drivers");
  revalidatePath(`/drivers/${id}`);
  redirect("/drivers");
}

// deleteDriverAction — issues DELETE /api/v1/drivers/:id. Success
// (HTTP 204) revalidates the list and redirects back to it. 404 is
// surfaced inline (the row may have been deleted by another session
// between the dialog opening and the confirm click). Other errors
// surface generically.
export async function deleteDriverAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/drivers/${id}`, { method: "DELETE" });
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

  revalidatePath("/drivers");
  redirect("/drivers");
}
