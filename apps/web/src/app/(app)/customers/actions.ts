"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateCustomerFormSchema,
  UpdateCustomerFormSchema,
  type CreateCustomerFormValues,
  type UpdateCustomerFormValues,
} from "@/lib/customers-schema";

// Server actions for the Customers write path — create, update,
// delete. All three call apiFetch from the server context (cookies
// forward automatically) and reshape API errors into a structured
// result the client can render inline. Success paths use Next.js's
// redirect, which throws NEXT_REDIRECT and is caught by the framework
// as a navigation, NOT as a real error.
//
// Mirror of apps/web/src/app/drivers/actions.ts in shape, conventions,
// and error model. Differences vs Drivers: the field token attached to
// 409 responses is "panNumber" (rather than "licenseNumber"), and the
// delete action handles the future Jobs-FK 409 by passing the API's
// message through unchanged — the API names that exact wire shape in
// CustomersController.remove's JSDoc.

export interface ActionError {
  ok: false;
  message: string;
  // Status code so the client can distinguish validation errors (400)
  // from conflicts (409) from auth failures (401), even though the
  // user-facing message body is the same string today.
  status: number;
  // Optional field path so the create / edit form can surface a
  // duplicate-panNumber 409 inline on the panNumber input rather than
  // as a generic banner. Vehicles does not use this for delete — same
  // here: the delete-conflict surface (Jobs FK, iter 17+) is not a
  // field-level error.
  field?: string;
}

// createCustomerAction — POSTs a new customer. The client form gives
// us the full create payload (CreateCustomerFormValues); we re-validate
// server-side (the resolver runs in the browser; a determined attacker
// could submit a malformed payload directly), then POST. On success
// the function calls redirect("/customers") which throws NEXT_REDIRECT;
// the client form treats a thrown NEXT_REDIRECT as the success path.
// On failure, returns a structured error so the client renders the
// message inline.
//
// Duplicate panNumber → API returns 409. The runbook
// (docs/runbook/api-error-mapping.md) commits to P2002 → 409 with the
// offending field named in the message body; the API attaches
// `field: "panNumber"` to the response body, which we forward on
// ActionError so the form can show the message under the right input.
export async function createCustomerAction(
  values: CreateCustomerFormValues,
): Promise<ActionError | never> {
  const parsed = CreateCustomerFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Build the wire payload. Optional text fields are omitted when
  // blank so the API does not receive an empty string (which its
  // schema's `.min(1)` checks would reject as 400). The status field
  // is always sent — the form renders a select that always has a
  // value.
  const body: Record<string, unknown> = {
    name: parsed.data.name,
    phone: parsed.data.phone,
    status: parsed.data.status,
  };
  if (parsed.data.contactPerson && parsed.data.contactPerson.length > 0) {
    body.contactPerson = parsed.data.contactPerson;
  }
  if (parsed.data.email && parsed.data.email.length > 0) {
    body.email = parsed.data.email;
  }
  if (parsed.data.panNumber && parsed.data.panNumber.length > 0) {
    body.panNumber = parsed.data.panNumber;
  }
  if (parsed.data.address && parsed.data.address.length > 0) {
    body.address = parsed.data.address;
  }

  try {
    await apiFetch<unknown>("/api/v1/customers", { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      // 409 only happens for duplicate panNumber today (Customer's
      // only unique constraint). The API's response body carries
      // `field: "panNumber"`, but apiFetch's ApiError surface only
      // forwards `status` and `message`. Re-derive `field` from the
      // status code — same shortcut the Drivers action uses for
      // licenseNumber. If a future Customer model adds a second
      // unique field, this branch will need to inspect the body.
      const field = error.status === 409 ? "panNumber" : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/customers");
  redirect("/customers");
}

// updateCustomerAction — patches only the fields that actually changed
// vs. the user's initial form values. The caller (edit-customer-form)
// computes that diff client-side before invoking this action, so the
// payload never re-sends a field the user didn't touch. See DESIGN.md
// §"Inputs and forms" "Diff-against-initial-values for PATCH" for the
// project-wide pattern.
//
// Returns ActionError on failure; throws NEXT_REDIRECT on success.
export async function updateCustomerAction(
  id: string,
  changedFields: Partial<UpdateCustomerFormValues>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateCustomerFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Translate empty-string text fields into `null` when the field is
  // nullable on the wire (contactPerson, email, panNumber, address).
  // The edit form represents a cleared input as an empty string; the
  // API's schema rejects empty strings for these fields (each carries
  // a `.min(1)` "required when provided") but accepts `null` as the
  // explicit "clear" signal that the service-layer hasOwnProperty
  // branch consumes. Phone and name stay as-is (they are required on
  // the create surface and the edit form does not expose a clear-to-
  // empty affordance for them — sending an empty string would 400).
  const wirePayload: Record<string, unknown> = { ...parsed.data };
  for (const key of ["contactPerson", "email", "panNumber", "address"] as const) {
    if (wirePayload[key] === "") {
      wirePayload[key] = null;
    }
  }
  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/customers/${id}`, {
      method: "PATCH",
      json: wirePayload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      const field = error.status === 409 ? "panNumber" : undefined;
      return { ok: false, message: error.message, status: error.status, field };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/customers");
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${id}`);
}

// deleteCustomerAction — issues DELETE /api/v1/customers/:id. Success
// (HTTP 204) revalidates the list and redirects back to it. 404 is
// surfaced inline (the row may have been deleted by another session
// between the dialog opening and the confirm click). 409 surfaces the
// API's "Cannot delete customer: it is referenced by other records."
// message — currently dead code (no inbound FKs into Customer in iter
// 16) but iter 17's Jobs slice will add a FK and exercise this branch.
// No `field` token: a delete-block is not a field-level error.
export async function deleteCustomerAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/customers/${id}`, { method: "DELETE" });
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

  revalidatePath("/customers");
  redirect("/customers");
}
