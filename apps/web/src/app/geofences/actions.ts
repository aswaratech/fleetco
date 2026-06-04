"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateGeofenceFormSchema,
  UpdateGeofenceFormSchema,
  type CreateGeofenceFormValues,
  type UpdateGeofenceFormValues,
} from "@/lib/geofences-schema";

// Server actions for the Geofences write path (ADR-0030 G3) — create,
// update, delete. All three call apiFetch from the server context (cookies
// forward automatically) and reshape API errors into a structured result
// the client can render inline. Success paths use Next.js's redirect, which
// throws NEXT_REDIRECT and is caught by the framework as a navigation, NOT
// as a real error.
//
// Mirror of apps/web/src/app/customers/actions.ts + the fuel-logs /
// expense-logs field-token error model. The geofence-specific shape:
//
//   - The wire `boundary` field is the `lon,lat;…` vertex string (NOT the
//     stored `boundaryWkt`). The form collects it; the action sends it
//     verbatim and the API's shared PolygonParser builds the WKT.
//   - The create/update bodies are `.strict()` on the API; we send exactly
//     { name, type, boundary, customerId? } — customerId only for
//     CUSTOMER_SITE (the API's superRefine forbids it otherwise).
//   - Field-token mapping (mapApiErrorToActionError): the ST_IsValid /
//     parse 400 surfaces on `boundary`; the type/ownership refine 400 and
//     the stale-customerId P2003 → 400 both surface on `customerId`.
//   - DELETE never returns 409 — nothing FKs INTO Geofence (the customer-
//     side delete blocker lives on CustomersService). 404 is surfaced
//     inline by the dialog.

export interface ActionError {
  ok: false;
  message: string;
  // Status code so the client can distinguish validation errors (400) from
  // auth failures (401). 409 is not reachable for a Geofence write
  // (Geofence has no unique columns aside from `id`, and no inbound FK).
  status: number;
  // Optional field path so the create / edit form can surface a 400 inline
  // on the right input: "boundary" or "customerId".
  field?: string;
}

// createGeofenceAction — POSTs a new geofence. The client form gives us the
// full create payload; we re-validate server-side (defense in depth — a
// determined caller could submit a malformed payload directly), then POST.
// On success the function calls redirect("/geofences/<id>") (back to the new
// geofence's detail page — matches the Jobs / Expense-logs create flow),
// which throws NEXT_REDIRECT; the client form treats that as the success
// path. On failure, returns a structured error so the client renders the
// message inline.
export async function createGeofenceAction(
  values: CreateGeofenceFormValues,
): Promise<ActionError | never> {
  const parsed = CreateGeofenceFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Build the wire payload. name / type / boundary are always sent.
  // customerId is sent ONLY when present — the schema's superRefine has
  // already guaranteed it is set iff the type is CUSTOMER_SITE, so the API's
  // `.strict()` superRefine will accept exactly this shape.
  const body: Record<string, unknown> = {
    name: parsed.data.name,
    type: parsed.data.type,
    boundary: parsed.data.boundary,
  };
  if (parsed.data.customerId && parsed.data.customerId.length > 0) {
    body.customerId = parsed.data.customerId;
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/geofences", { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/geofences");
  redirect(`/geofences/${created.id}`);
}

// updateGeofenceAction — patches only the fields that actually changed vs.
// the user's initial form values. The caller (edit-geofence-form) computes
// that diff client-side before invoking this action, so the payload never
// re-sends a field the user didn't touch. See DESIGN.md §"Inputs and forms"
// "Diff-against-initial-values for PATCH" for the project-wide pattern.
//
// All four fields are mutable. customerId uses the `in`-operator discipline
// for the nullable FK: a key present in the diff with value "" maps to wire
// `null` (clear the owner — the explicit signal the service's hasOwnProperty
// branch consumes); a non-empty value sets it. The API re-runs the
// type/ownership invariant and (if boundary changed) the ST_IsValid gate
// against the merged shape and remains authoritative.
//
// Returns ActionError on failure; throws NEXT_REDIRECT on success.
export async function updateGeofenceAction(
  id: string,
  changedFields: Partial<UpdateGeofenceFormValues>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateGeofenceFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Translate the validated diff into the API's wire shape. name / type /
  // boundary are sent verbatim when present. customerId: "" → null (clear),
  // a cuid → the id.
  const wirePayload: Record<string, unknown> = {};
  if ("name" in changedFields && parsed.data.name !== undefined) {
    wirePayload.name = parsed.data.name;
  }
  if ("type" in changedFields && parsed.data.type !== undefined) {
    wirePayload.type = parsed.data.type;
  }
  if ("boundary" in changedFields && parsed.data.boundary !== undefined) {
    wirePayload.boundary = parsed.data.boundary;
  }
  if ("customerId" in changedFields) {
    wirePayload.customerId =
      parsed.data.customerId && parsed.data.customerId.length > 0 ? parsed.data.customerId : null;
  }

  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/geofences/${id}`, { method: "PATCH", json: wirePayload });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/geofences");
  revalidatePath(`/geofences/${id}`);
  redirect(`/geofences/${id}`);
}

// deleteGeofenceAction — issues DELETE /api/v1/geofences/:id. Success (HTTP
// 204) revalidates the list and redirects back to it. 404 is surfaced inline
// by the dialog (the row may have been deleted by another session between
// the dialog opening and the confirm click). No 409 — Geofence is a leaf
// aggregate (nothing FKs into it).
export async function deleteGeofenceAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/geofences/${id}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/geofences");
  redirect("/geofences");
}

// Map an ApiError into an ActionError with a field token when the message
// identifies a specific input. The boundary-validity messages come from the
// service's ST_IsValid gate ("... is not a valid polygon: the ring is
// self-intersecting or degenerate.") and the ST_GeomFromText parse guard
// ("... is not a parseable polygon."). The ownership messages come from the
// type/ownership refine ("A customer-site geofence requires a customerId.",
// "A DEPOT geofence must not have a customerId."); the stale-FK message comes
// from the P2003 mapper ("Customer <id> does not exist."). The two groups are
// disjoint (boundary messages never mention "customer"; ownership/FK messages
// never mention "polygon"/"boundary"), so substring routing is unambiguous.
// Any other 400 falls through to the generic banner.
function mapApiErrorToActionError(error: ApiError): ActionError {
  if (error.status === 400) {
    if (/boundary|polygon/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "boundary" };
    }
    if (/customer/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "customerId" };
    }
  }
  return { ok: false, message: error.message, status: error.status };
}
