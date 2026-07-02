"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateTrackerFormSchema,
  UpdateTrackerFormSchema,
  type CreateTrackerFormValues,
  type UpdateTrackerFormValues,
} from "@/lib/trackers-schema";

// Server actions for the TrackerDevice write path (ADR-0042 M4) — create
// and update. There is deliberately NO delete action: the API exposes no
// delete route (unassign frees the vehicle slot; RETIRED ends the
// lifecycle with the row kept). Both actions call apiFetch from the server
// context (cookies forward automatically) and reshape API errors into a
// structured result the client renders inline. Success paths use Next.js's
// redirect (NEXT_REDIRECT), the same model as the geofences actions.
//
// The tracker-specific error surface (mapApiErrorToActionError):
//   - 409 "A tracker with IMEI …" (P2002 on imei) → field `imei`;
//   - 409 "Vehicle … already has a tracker" (P2002 on the one-tracker-
//     per-vehicle slot) and 400 "Vehicle … does not exist." (stale FK) and
//     400 "Unassign the tracker from its vehicle…" (the retirement
//     invariant) all name the vehicle → field `vehicleId`.
// The two groups are disjoint (IMEI messages never mention "vehicle";
// vehicle messages never mention "IMEI"), so substring routing is
// unambiguous. Any other status falls through to the generic banner.

export interface ActionError {
  ok: false;
  message: string;
  // Status so the client can distinguish validation (400) / conflict (409)
  // from auth failures (401).
  status: number;
  // Optional field path so the create / edit form can surface the error
  // inline on the right input: "imei" or "vehicleId".
  field?: string;
}

// createTrackerAction — POSTs a new tracker registration. Re-validates
// server-side (defense in depth), strips the empty-string stand-ins the
// DOM uses ("" = not provided / unassigned) out of the wire payload — the
// API's `.strict()` schema wants absent keys, not empty strings — then
// POSTs. On success redirects to the new tracker's detail page.
export async function createTrackerAction(
  values: CreateTrackerFormValues,
): Promise<ActionError | never> {
  const parsed = CreateTrackerFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const body: Record<string, unknown> = {
    imei: parsed.data.imei,
    status: parsed.data.status,
  };
  if (parsed.data.label.length > 0) body.label = parsed.data.label;
  if (parsed.data.simMsisdn.length > 0) body.simMsisdn = parsed.data.simMsisdn;
  if (parsed.data.vehicleId && parsed.data.vehicleId.length > 0) {
    body.vehicleId = parsed.data.vehicleId;
  }
  if (parsed.data.installedAt.length > 0) body.installedAt = parsed.data.installedAt;

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/telematics/trackers", {
      method: "POST",
      json: body,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/trackers");
  redirect(`/trackers/${created.id}`);
}

// updateTrackerAction — patches only the fields that actually changed vs.
// the user's initial form values (the edit form computes the diff
// client-side; DESIGN.md §"Inputs and forms" "Diff-against-initial-values
// for PATCH"). The nullable columns use the `in`-operator discipline: a key
// present in the diff with value "" maps to wire `null` (clear the label /
// SIM / install date, or UNASSIGN the vehicle — the explicit signal the
// service's hasOwnProperty branch consumes); a non-empty value sets it.
// The API re-runs the retirement invariant against the merged shape and
// remains authoritative.
export async function updateTrackerAction(
  id: string,
  changedFields: Partial<UpdateTrackerFormValues>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateTrackerFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const wirePayload: Record<string, unknown> = {};
  if ("imei" in changedFields && parsed.data.imei !== undefined) {
    wirePayload.imei = parsed.data.imei;
  }
  if ("status" in changedFields && parsed.data.status !== undefined) {
    wirePayload.status = parsed.data.status;
  }
  if ("label" in changedFields && parsed.data.label !== undefined) {
    wirePayload.label = parsed.data.label.length > 0 ? parsed.data.label : null;
  }
  if ("simMsisdn" in changedFields && parsed.data.simMsisdn !== undefined) {
    wirePayload.simMsisdn = parsed.data.simMsisdn.length > 0 ? parsed.data.simMsisdn : null;
  }
  if ("vehicleId" in changedFields) {
    wirePayload.vehicleId =
      parsed.data.vehicleId && parsed.data.vehicleId.length > 0 ? parsed.data.vehicleId : null;
  }
  if ("installedAt" in changedFields && parsed.data.installedAt !== undefined) {
    wirePayload.installedAt = parsed.data.installedAt.length > 0 ? parsed.data.installedAt : null;
  }

  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/telematics/trackers/${id}`, {
      method: "PATCH",
      json: wirePayload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/trackers");
  revalidatePath(`/trackers/${id}`);
  redirect(`/trackers/${id}`);
}

// Map an ApiError into an ActionError with a field token when the message
// identifies a specific input (see the file header for the message
// taxonomy). Both 400s and 409s can be field-specific here — unlike
// geofences, the tracker register has unique columns, so conflicts are a
// first-class inline-error case.
function mapApiErrorToActionError(error: ApiError): ActionError {
  if (error.status === 400 || error.status === 409) {
    if (/imei/i.test(error.message)) {
      return { ok: false, message: error.message, status: error.status, field: "imei" };
    }
    if (/vehicle|unassign/i.test(error.message)) {
      return { ok: false, message: error.message, status: error.status, field: "vehicleId" };
    }
  }
  return { ok: false, message: error.message, status: error.status };
}
