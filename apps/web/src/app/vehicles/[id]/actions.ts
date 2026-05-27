"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import { UpdateVehicleFormSchema, type UpdateVehicleFormValues } from "@/lib/vehicles-schema";

// Server actions for the /vehicles/[id] surface — update and delete.
// Both call apiFetch from the server context (cookies forward
// automatically) and reshape API errors into a structured result the
// client can render inline. The success paths use Next.js's redirect
// (which throws NEXT_REDIRECT and is caught by the framework as a
// navigation, NOT as a real error).

export interface ActionError {
  ok: false;
  message: string;
  status: number;
}

// updateVehicleAction — patches only the fields that actually changed
// vs. the user's initial form values. The caller (edit-vehicle-form)
// computes that diff client-side before invoking this action, so the
// payload never re-sends a status field the user didn't touch. This
// matters because the API's retirement-transition rule
// (VehiclesService.update) keys off status changes: a stale status
// resend would not trigger the rule but a deliberate change to the
// same value WOULD trigger it on the server side, which is the wrong
// behavior. See DESIGN.md §"Inputs and forms" "Diff-against-initial-
// values for PATCH" for the project-wide pattern.
//
// Returns ActionError on failure (400 / 404 / 409 / network).
// Throws NEXT_REDIRECT on success — the framework treats it as
// navigation; the client form interprets a thrown NEXT_REDIRECT as
// the success path.
export async function updateVehicleAction(
  id: string,
  changedFields: Partial<UpdateVehicleFormValues>,
): Promise<ActionError | never> {
  // Empty diff: nothing changed. Surface as a clear inline message
  // rather than letting the API reject with 400 "At least one field
  // is required" — the user shouldn't see API-validation language for
  // a UX-level no-op.
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  // Re-validate server-side (the resolver runs in the browser; an
  // attacker could craft a malformed payload). UpdateVehicleFormSchema
  // is .partial() over VehicleFormSchema plus an optional retiredAt;
  // safeParse here mirrors the API's authoritative schema.
  const parsed = UpdateVehicleFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Compliance metadata (iter 14): a cleared field arrives in the diff
  // as "" (the form input was emptied). The API's UpdateVehicleSchema
  // rejects "" on these fields (ComplianceString requires min length 1)
  // — to *clear* a column the API expects an explicit null. So map any
  // empty-string compliance value to null before sending. Non-compliance
  // fields (registrationNumber etc.) are never blanked through this form,
  // so they don't need the same treatment.
  const complianceKeys = [
    "bluebookNumber",
    "bluebookExpiresAt",
    "insurer",
    "insurancePolicyNumber",
    "insuranceType",
    "insuranceExpiresAt",
    "routePermitNumber",
    "routePermitExpiresAt",
  ] as const;
  const wireBody: Record<string, unknown> = { ...parsed.data };
  for (const key of complianceKeys) {
    if (wireBody[key] === "") {
      wireBody[key] = null;
    }
  }

  try {
    await apiFetch<unknown>(`/api/v1/vehicles/${id}`, {
      method: "PATCH",
      // Pass only the diff. wireBody contains the validated subset of
      // the user's changes (with cleared compliance fields normalized to
      // null); the API rejects unknown keys via .strict().
      json: wireBody,
    });
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

  // Invalidate both the list and the detail so the next view sees the
  // updated row; redirect back to the list (ticket spec).
  revalidatePath("/vehicles");
  revalidatePath(`/vehicles/${id}`);
  redirect("/vehicles");
}

// deleteVehicleAction — issues DELETE /api/v1/vehicles/:id. Success
// (HTTP 204) revalidates the list and redirects back to it. 404 is
// surfaced inline (the row may have been deleted by another session
// between the dialog opening and the confirm click). Other errors
// surface generically.
export async function deleteVehicleAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/vehicles/${id}`, { method: "DELETE" });
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

  revalidatePath("/vehicles");
  redirect("/vehicles");
}
