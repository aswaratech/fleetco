"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateSiteFormSchema,
  UpdateSiteFormSchema,
  type CreateSiteFormValues,
  type UpdateSiteFormValues,
} from "@/lib/sites-schema";

// Server actions for the Sites write path (ADR-0047 W5) — create, update,
// delete. All three call apiFetch from the server context (cookies forward
// automatically) and reshape API errors into a structured result the client can
// render inline. Success paths use Next.js's redirect, which throws
// NEXT_REDIRECT and is caught by the framework as a navigation, NOT a real
// error.
//
// Mirror of apps/web/src/app/(app)/geofences/actions.ts. The Site-specific
// shape:
//   - The wire body sends latitude / longitude as JSON NUMBERS (the API's
//     CreateSiteSchema takes z.number, not strings), converted from the form's
//     string fields via Number(...). The form's zod mirror has already
//     range-checked them, so Number() cannot produce NaN here.
//   - Optional address / contactName / contactPhone: on create an empty value
//     is OMITTED (a missing key is treated as null by the API); on update the
//     in-operator discipline maps a cleared field ("") to wire `null` and a
//     filled field to the value.
//   - The create/update bodies are .strict() on the API, so we send exactly the
//     known keys.
//   - DELETE surfaces the P2003 → 409 "Cannot delete site: N trips reference
//     this site." to the dialog (a Site referenced by a trip's pickup/drop-off
//     under onDelete: Restrict), and a 404 if the row already vanished.

export interface ActionError {
  ok: false;
  message: string;
  // Status code so the client can distinguish validation errors (400) from auth
  // failures (401). Site has no unique columns, so there is no 409 conflict on
  // create/update — only the delete-blocker 409, handled by the dialog.
  status: number;
  // Optional field path so the create / edit form can surface a 400 inline on
  // the right input: "name" | "latitude" | "longitude".
  field?: string;
}

// createSiteAction — POSTs a new site. Re-validates server-side (defense in
// depth — a determined caller could submit a malformed payload directly), then
// POSTs. On success calls redirect("/sites/<id>") (back to the new site's
// detail page — matches the geofences / jobs create flow), which throws
// NEXT_REDIRECT; the client form treats that as the success path.
export async function createSiteAction(values: CreateSiteFormValues): Promise<ActionError | never> {
  const parsed = CreateSiteFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const body: Record<string, unknown> = {
    name: parsed.data.name,
    kind: parsed.data.kind,
    latitude: Number(parsed.data.latitude),
    longitude: Number(parsed.data.longitude),
  };
  // Optional strings: send only when non-empty (a blank input means "absent",
  // and the API treats a missing key the same as null).
  const address = parsed.data.address?.trim();
  const contactName = parsed.data.contactName?.trim();
  const contactPhone = parsed.data.contactPhone?.trim();
  if (address) body.address = address;
  if (contactName) body.contactName = contactName;
  if (contactPhone) body.contactPhone = contactPhone;

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/sites", { method: "POST", json: body });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/sites");
  redirect(`/sites/${created.id}`);
}

// updateSiteAction — PATCHes only the fields that actually changed vs. the
// user's initial form values (the caller computes that diff client-side). name
// / kind / latitude / longitude are non-nullable, so a present-in-diff value is
// sent verbatim (numbers for the coordinates). The optional strings use the
// in-operator discipline: a key present in the diff with value "" maps to wire
// `null` (clear the field); a non-empty value sets it. Returns ActionError on
// failure; throws NEXT_REDIRECT on success.
export async function updateSiteAction(
  id: string,
  changedFields: Partial<UpdateSiteFormValues>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateSiteFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  const wirePayload: Record<string, unknown> = {};
  if ("name" in changedFields && parsed.data.name !== undefined) {
    wirePayload.name = parsed.data.name;
  }
  if ("kind" in changedFields && parsed.data.kind !== undefined) {
    wirePayload.kind = parsed.data.kind;
  }
  if ("latitude" in changedFields && parsed.data.latitude !== undefined) {
    wirePayload.latitude = Number(parsed.data.latitude);
  }
  if ("longitude" in changedFields && parsed.data.longitude !== undefined) {
    wirePayload.longitude = Number(parsed.data.longitude);
  }
  // Nullable optional strings: cleared ("") → null; filled → trimmed value.
  for (const key of ["address", "contactName", "contactPhone"] as const) {
    if (key in changedFields) {
      const raw = parsed.data[key];
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      wirePayload[key] = trimmed.length > 0 ? trimmed : null;
    }
  }

  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/sites/${id}`, { method: "PATCH", json: wirePayload });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/sites");
  revalidatePath(`/sites/${id}`);
  redirect(`/sites/${id}`);
}

// deleteSiteAction — issues DELETE /api/v1/sites/:id. Success (HTTP 204)
// revalidates the list and redirects back to it. The dialog surfaces any
// ApiError message inline — notably the 409 delete-blocker ("Cannot delete
// site: N trips reference this site.") when the Site is a trip's pickup/drop-off
// under onDelete: Restrict, and a 404 if the row already vanished between the
// dialog opening and the confirm click.
export async function deleteSiteAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/sites/${id}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/sites");
  redirect("/sites");
}

// Map an ApiError into an ActionError with a field token when the message
// identifies a specific input. The API's field-level 400s are the coordinate
// range messages ("Latitude must be between -90 and 90.", etc.) and the name
// messages ("Name is required." / "Name is too long."); these route to the
// matching input so the form highlights it. Any other 400 falls through to the
// generic banner. The three groups are disjoint (a coordinate message never
// mentions "name"), so substring routing is unambiguous.
function mapApiErrorToActionError(error: ApiError): ActionError {
  if (error.status === 400) {
    if (/latitude/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "latitude" };
    }
    if (/longitude/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "longitude" };
    }
    if (/name/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "name" };
    }
  }
  return { ok: false, message: error.message, status: error.status };
}
