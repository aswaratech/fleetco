"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateExpenseLogFormSchema,
  UpdateExpenseLogFormSchema,
  rupeesToPaisa,
  type CreateExpenseLogFormInput,
  type UpdateExpenseLogFormInput,
} from "@/lib/expense-logs-schema";

// Server actions for the Expense-logs write path (iter 22) — create,
// update, delete. All three call apiFetch from the server context
// (cookies forward automatically) and reshape API errors into a
// structured result the client can render inline. Success paths use
// Next.js's redirect, which throws NEXT_REDIRECT and is caught by the
// framework as a navigation, NOT as a real error.
//
// Mirror of apps/web/src/app/fuel-logs/actions.ts in shape, conventions,
// and error model. Three expense-log-specific divergences (per the
// iter-22 kickoff):
//
//   1. amountPaisa is AUTHORITATIVE. The form collects a single
//      `amount` decimal field (NPR rupees); this layer converts to
//      `amountPaisa` via `rupeesToPaisa` (Math.round(rupees * 100)).
//      No derivation, no preview, no double-write of a derived field.
//
//   2. vehicleId is OPTIONAL+NULLABLE on Create. When the form's
//      vehicleId is "" (the "— no vehicle —" picker option), this
//      layer OMITS `vehicleId` from the wire body (the API's POST
//      schema accepts the absence; vehicle-agnostic expenses are a
//      first-class shape). Same for tripId.
//
//   3. vehicleId is IMMUTABLE on Update. UpdateExpenseLogFormInput
//      has no `vehicleId` field; this layer additionally never
//      writes a `vehicleId` key into the PATCH body (defense in
//      depth — the API's PATCH .strict() rejects it independently).
//
// 400 with the API's "Trip <id> belongs to vehicle ..." body is
// surfaced as `field: "tripId"` so the form can highlight the trip
// picker. 400 with "Vehicle <id> does not exist" surfaces as
// `field: "vehicleId"` (only reachable on create — vehicleId is
// rejected by the wire on PATCH).

export interface ActionError {
  ok: false;
  message: string;
  // Status code so the client can distinguish validation errors (400)
  // from auth failures (401). 409 is not reachable today (ExpenseLog
  // has no unique columns aside from `id`).
  status: number;
  // Optional field path so the create / edit form can surface a
  // vehicleId / tripId 400 inline against the right picker.
  field?: string;
}

// createExpenseLogAction — POSTs a new expense log. The client form
// gives us the raw form input (CreateExpenseLogFormInput — every field
// a string); we re-validate server-side via the same schema (defense
// in depth), convert the decimal amount into integer paisa, then
// POST. On success the function calls redirect("/expense-logs/<id>")
// which throws NEXT_REDIRECT.
//
// 400 with the vehicle-not-found / trip-mismatch / trip-not-found
// phrasing surfaces as a field-level error so the form can highlight
// the right picker.
export async function createExpenseLogAction(
  values: CreateExpenseLogFormInput,
): Promise<ActionError | never> {
  const parsed = CreateExpenseLogFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Build the wire payload. Required: date, category, amountPaisa.
  // Optional: vehicleId, tripId, vendor, receiptNumber, notes. We
  // OMIT optional fields when they are unset rather than sending null
  // — the API's POST schema accepts undefined for optional fields.
  const body: Record<string, unknown> = {
    date: parsed.data.date,
    category: parsed.data.category,
    amountPaisa: rupeesToPaisa(parsed.data.amount),
  };
  if (parsed.data.vehicleId && parsed.data.vehicleId.length > 0) {
    body.vehicleId = parsed.data.vehicleId;
  }
  if (parsed.data.tripId && parsed.data.tripId.length > 0) {
    body.tripId = parsed.data.tripId;
  }
  if (parsed.data.vendor !== undefined) {
    body.vendor = parsed.data.vendor;
  }
  if (parsed.data.receiptNumber !== undefined) {
    body.receiptNumber = parsed.data.receiptNumber;
  }
  if (parsed.data.notes !== undefined) {
    body.notes = parsed.data.notes;
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/expense-logs", {
      method: "POST",
      json: body,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/expense-logs");
  redirect(`/expense-logs/${created.id}`);
}

// updateExpenseLogAction — patches only the fields that actually
// changed vs. the user's initial form values. The caller
// (edit-expense-log-form) computes that diff client-side before
// invoking this action, so the payload never re-sends a field the
// user didn't touch.
//
// vehicleId is intentionally NOT in UpdateExpenseLogFormInput —
// immutable; the API's .strict() rejects it. tripId IS — mutable.
//
// Returns ActionError on failure; throws NEXT_REDIRECT on success.
export async function updateExpenseLogAction(
  id: string,
  changedFields: Partial<UpdateExpenseLogFormInput>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateExpenseLogFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Translate the form's resolved values into the API's wire shape.
  // For mutable nullable fields (tripId, vendor, receiptNumber,
  // notes), empty / undefined → null on the wire (the explicit
  // "clear" signal the service-layer hasOwnProperty branch consumes).
  // For the integer-converted field (amount), we multiply through and
  // rename to the API's key (amountPaisa).
  const wirePayload: Record<string, unknown> = {};

  // tripId: only touched if the form's `tripId` key is present in
  // changedFields. The form sends "" to explicitly clear the pairing
  // (null on the wire) and a cuid string to set it.
  if ("tripId" in changedFields) {
    wirePayload.tripId =
      parsed.data.tripId && parsed.data.tripId.length > 0 ? parsed.data.tripId : null;
  }

  if ("date" in changedFields && parsed.data.date && parsed.data.date.length > 0) {
    wirePayload.date = parsed.data.date;
  }

  if ("category" in changedFields && parsed.data.category !== undefined) {
    wirePayload.category = parsed.data.category;
  }

  if ("amount" in changedFields && parsed.data.amount !== undefined) {
    wirePayload.amountPaisa = rupeesToPaisa(parsed.data.amount);
  }

  if ("vendor" in changedFields) {
    wirePayload.vendor = parsed.data.vendor !== undefined ? parsed.data.vendor : null;
  }

  if ("receiptNumber" in changedFields) {
    wirePayload.receiptNumber =
      parsed.data.receiptNumber !== undefined ? parsed.data.receiptNumber : null;
  }

  if ("notes" in changedFields) {
    wirePayload.notes = parsed.data.notes !== undefined ? parsed.data.notes : null;
  }

  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  // Defense in depth: vehicleId is immutable. The UpdateExpense-
  // LogFormInput type does not include it, but if a future refactor
  // introduces a key with that name we'd rather drop it here than
  // send it to the wire. The API's PATCH .strict() would also reject
  // it; this is a belt-and-braces guard.
  if ("vehicleId" in wirePayload) {
    delete (wirePayload as Record<string, unknown>).vehicleId;
  }

  try {
    await apiFetch<unknown>(`/api/v1/expense-logs/${id}`, {
      method: "PATCH",
      json: wirePayload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/expense-logs");
  revalidatePath(`/expense-logs/${id}`);
  redirect(`/expense-logs/${id}`);
}

// deleteExpenseLogAction — issues DELETE /api/v1/expense-logs/:id.
// Success (HTTP 204) revalidates the list and redirects back to it.
// 404 is surfaced inline by the dialog (the row may have been deleted
// by another session between the dialog opening and the confirm
// click). No 409 today — ExpenseLog is a leaf aggregate (no inbound
// FKs).
export async function deleteExpenseLogAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/expense-logs/${id}`, { method: "DELETE" });
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

  revalidatePath("/expense-logs");
  redirect("/expense-logs");
}

// Map an ApiError into an ActionError with a field token when the
// message identifies a specific picker. The trip-vehicle mismatch
// message comes from ExpenseLogsService.assertTripBelongsToVehicle
// and reads "Trip <reg> belongs to vehicle <reg>; cannot pair with an
// expense log for vehicle <reg>." The Vehicle / Trip not-found
// messages come from the P2003 mapper and read "Vehicle <id> does
// not exist." / "Trip <id> does not exist." We pattern-match on those
// substrings to route to the right picker. Any other 400 falls
// through to the generic banner.
function mapApiErrorToActionError(error: ApiError): ActionError {
  if (error.status === 400) {
    if (/trip .* belongs to vehicle/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "tripId" };
    }
    if (/vehicle .* does not exist/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "vehicleId" };
    }
    if (/trip .* does not exist/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "tripId" };
    }
  }
  return { ok: false, message: error.message, status: error.status };
}
