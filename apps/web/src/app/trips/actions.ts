"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateTripFormSchema,
  UpdateTripFormSchema,
  type CreateTripFormValues,
  type UpdateTripFormValues,
} from "@/lib/trips-schema";

// Server actions for the Trips write path (iter 9) — create, update,
// delete. Mirrors apps/web/src/app/drivers/actions.ts in shape:
// validate on the server in case a determined client sends malformed
// payloads directly; reshape the API's `ApiError` into a structured
// result for the client form to render inline; on success redirect
// (which throws `NEXT_REDIRECT` and is caught by the framework as a
// navigation, not a real error).
//
// The Trip write surface is more complex than Drivers / Vehicles in
// two ways:
//   - Three FK-touching fields (`vehicleId`, `driverId`) so a 400 can
//     come from the API for several reasons; the action surfaces the
//     API's message verbatim.
//   - Cross-field rules tied to status; the client form's resolver
//     already enforces them, but the server side re-runs the schema in
//     case the form was bypassed.

export interface TripActionError {
  ok: false;
  message: string;
  status: number;
  field?: string;
}

// Convert a datetime-local form value (`YYYY-MM-DDTHH:MM` or
// `YYYY-MM-DDTHH:MM:SS`) to a wire-side ISO 8601 UTC string. The form
// renders local time but does not collect a timezone (browsers do not
// surface one through datetime-local); we treat the bare value as UTC
// for the wire — the same convention the Drivers / Vehicles date
// inputs use. A future <NepaliDate /> component (DESIGN.md §"BS
// calendar") will own timezone handling explicitly.
function toWireISO(value: string): string {
  // If already includes seconds, just append Z; otherwise append :00Z.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value}Z`;
  }
  return `${value}:00Z`;
}

// Build the create wire body from validated form values. Empty
// optional fields are omitted from the wire body so the API's schema
// sees `undefined` (the "not set" branch) rather than an empty string
// or null.
function buildCreateWireBody(values: CreateTripFormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {
    vehicleId: values.vehicleId,
    driverId: values.driverId,
    status: values.status,
  };
  if (values.startedAt && values.startedAt.length > 0) {
    body.startedAt = toWireISO(values.startedAt);
  }
  if (values.endedAt && values.endedAt.length > 0) {
    body.endedAt = toWireISO(values.endedAt);
  }
  if (values.startOdometerKm && values.startOdometerKm.length > 0) {
    body.startOdometerKm = Number(values.startOdometerKm);
  }
  if (values.endOdometerKm && values.endOdometerKm.length > 0) {
    body.endOdometerKm = Number(values.endOdometerKm);
  }
  if (values.notes && values.notes.length > 0) {
    body.notes = values.notes;
  }
  return body;
}

// Build the update wire body from the diff (already a Partial). Empty
// strings on nullable fields are translated to explicit `null` so the
// API clears the column rather than seeing "" (which would fail
// validation). `notes` is non-nullable on the API; an empty notes
// string is sent as `""` so the API accepts it as a value (the schema
// allows zero-length strings under the max-1000 constraint).
function buildUpdateWireBody(diff: Partial<UpdateTripFormValues>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if ("vehicleId" in diff && diff.vehicleId !== undefined) body.vehicleId = diff.vehicleId;
  if ("driverId" in diff && diff.driverId !== undefined) body.driverId = diff.driverId;
  if ("status" in diff && diff.status !== undefined) body.status = diff.status;
  if ("startedAt" in diff) {
    body.startedAt = diff.startedAt && diff.startedAt.length > 0 ? toWireISO(diff.startedAt) : null;
  }
  if ("endedAt" in diff) {
    body.endedAt = diff.endedAt && diff.endedAt.length > 0 ? toWireISO(diff.endedAt) : null;
  }
  if ("startOdometerKm" in diff) {
    body.startOdometerKm =
      diff.startOdometerKm && diff.startOdometerKm.length > 0 ? Number(diff.startOdometerKm) : null;
  }
  if ("endOdometerKm" in diff) {
    body.endOdometerKm =
      diff.endOdometerKm && diff.endOdometerKm.length > 0 ? Number(diff.endOdometerKm) : null;
  }
  if ("notes" in diff) {
    body.notes = diff.notes ?? "";
  }
  return body;
}

// createTripAction — POSTs a new trip. On success the API returns the
// created Trip (with its assigned id); we redirect to the detail page
// for the new id so the operator lands on confirmation of what they
// just created. Iter-9 kickoff names `/trips/<new-id>` as the redirect
// target.
export async function createTripAction(
  values: CreateTripFormValues,
): Promise<TripActionError | never> {
  const parsed = CreateTripFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const body = buildCreateWireBody(parsed.data);

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/trips", { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      // The API's BadRequestException for an FK miss (P2003 on insert)
      // is shaped as 400 with a message naming the field; we forward
      // the message and let the form render it inline. The cross-field
      // 400s (status × timing) also flow through here unchanged.
      return { ok: false, message: error.message, status: error.status };
    }
    return {
      ok: false,
      message: "Could not reach the FleetCo API. Try again.",
      status: 0,
    };
  }

  revalidatePath("/trips");
  redirect(`/trips/${created.id}`);
}

// updateTripAction — PATCHes only the fields that actually changed
// vs. the user's initial form values. The caller (edit-trip-form)
// computes that diff client-side before invoking this action.
//
// Cross-field validation re-runs server-side against the MERGED shape
// (initial values + diff). For example: an edit that flips status to
// COMPLETED while only changing one timing field still needs to
// validate "all four start/end fields are set" against the merged
// shape, not just the diff. The form is responsible for passing the
// merged shape for validation while sending only the diff over the
// wire.
export async function updateTripAction(
  id: string,
  diff: Partial<UpdateTripFormValues>,
  merged: UpdateTripFormValues,
): Promise<TripActionError | never> {
  if (Object.keys(diff).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsedMerged = UpdateTripFormSchema.safeParse(merged);
  if (!parsedMerged.success) {
    const issues = parsedMerged.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const body = buildUpdateWireBody(diff);
  if (Object.keys(body).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/trips/${id}`, { method: "PATCH", json: body });
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

  revalidatePath("/trips");
  revalidatePath(`/trips/${id}`);
  redirect(`/trips/${id}`);
}

// deleteTripAction — issues DELETE /api/v1/trips/:id. Success (204)
// revalidates the list and redirects back to it. 404 surfaces inline
// (the row may have been deleted by another session). Other errors
// surface generically.
export async function deleteTripAction(id: string): Promise<TripActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/trips/${id}`, { method: "DELETE" });
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

  revalidatePath("/trips");
  redirect("/trips");
}
