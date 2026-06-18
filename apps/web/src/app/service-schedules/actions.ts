"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateServiceScheduleFormSchema,
  UpdateServiceScheduleFormSchema,
  intervalValueToMinorUnits,
  type CreateServiceScheduleFormValues,
  type ServiceIntervalTypeName,
  type UpdateServiceScheduleFormValues,
} from "@/lib/service-schedules-schema";
import { hoursToTenths } from "@/lib/units";

// Server actions for the ServiceSchedule write path (ADR-0037 B5) — create,
// update, delete. All three call apiFetch from the server context (cookies
// forward automatically) and reshape API errors into a structured result the
// client can render inline. Success paths use Next.js's redirect, which throws
// NEXT_REDIRECT and is caught by the framework as a navigation, NOT a real
// error. Mirror of apps/web/src/app/geofences/actions.ts in shape + error model.
//
// THE INTERVAL CONVERSION (ADR-0037 c2): the form collects a human number whose
// unit is fixed by intervalType (km / decimal hours / days); this layer converts
// it to the wire integer minor units via `intervalValueToMinorUnits`
// (hours → tenths). The last-service anchor meter readings convert the same way
// (odometer is integer km; engine-hours decimal → tenths). Blank optional anchor
// fields are OMITTED so the API seeds them from the vehicle's current reading
// (ADR-0037 c4).
//
// Field-token routing (mapApiErrorToActionError): the API's `field` token is not
// forwarded by apiFetch (it surfaces only status + message), so we re-derive it
// — a 409 is always the duplicate-(vehicleId,name) conflict (→ "name"); a 400
// whose message names the meter-consistency rule routes to "intervalType", and a
// stale-vehicle 400 routes to "vehicleId". The two 400 messages are disjoint
// (one names "engine-hours", the other "does not exist"), so the routing is
// unambiguous.

export interface ActionError {
  ok: false;
  message: string;
  status: number;
  // Optional field path so the create / edit form can surface the error inline
  // on the right input: "name" (409), "intervalType" (meter-consistency 400),
  // or "vehicleId" (stale-FK 400).
  field?: string;
}

// createServiceScheduleAction — POSTs a new schedule. Re-validates server-side
// (defense in depth), converts the human interval + anchor values to wire
// integers, then POSTs. Redirects to the new schedule's detail page on success.
export async function createServiceScheduleAction(
  values: CreateServiceScheduleFormValues,
): Promise<ActionError | never> {
  const parsed = CreateServiceScheduleFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }
  const data = parsed.data;

  const body: Record<string, unknown> = {
    vehicleId: data.vehicleId,
    name: data.name,
    intervalType: data.intervalType,
    intervalValue: intervalValueToMinorUnits(data.intervalType, Number(data.intervalValue)),
    status: data.status,
  };
  if (data.description && data.description.trim().length > 0) {
    body.description = data.description.trim();
  }
  // The last-service anchor: omit blank fields so the API seeds them from the
  // vehicle's current reading (ADR-0037 c4). lastServiceAt applies to every
  // dimension; the meter reading only to its own dimension.
  if (data.lastServiceAt && data.lastServiceAt.length > 0) {
    body.lastServiceAt = data.lastServiceAt;
  }
  if (
    data.intervalType === "DISTANCE_KM" &&
    data.lastServiceOdometerKm &&
    data.lastServiceOdometerKm.trim().length > 0
  ) {
    body.lastServiceOdometerKm = Number(data.lastServiceOdometerKm);
  }
  if (
    data.intervalType === "ENGINE_HOURS" &&
    data.lastServiceEngineHours &&
    data.lastServiceEngineHours.trim().length > 0
  ) {
    body.lastServiceEngineHours = hoursToTenths(Number(data.lastServiceEngineHours));
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/service-schedules", {
      method: "POST",
      json: body,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/service-schedules");
  redirect(`/service-schedules/${created.id}`);
}

// updateServiceScheduleAction — patches only the changed fields. The edit form
// computes the diff (string fields) and passes the effective intervalType (the
// changed one, or the unchanged current one) so the action can convert
// `intervalValue` — its unit depends on the type and the diff may carry the
// value without the type. vehicleId is immutable (not in the form schema).
export async function updateServiceScheduleAction(
  id: string,
  changedFields: Partial<UpdateServiceScheduleFormValues>,
  intervalType: ServiceIntervalTypeName,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateServiceScheduleFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }
  const data = parsed.data;

  const wirePayload: Record<string, unknown> = {};
  if ("name" in changedFields && data.name !== undefined) {
    wirePayload.name = data.name;
  }
  // description is nullable on the wire: a cleared ("") value clears it (null).
  if ("description" in changedFields) {
    wirePayload.description =
      data.description && data.description.trim().length > 0 ? data.description.trim() : null;
  }
  if ("intervalType" in changedFields && data.intervalType !== undefined) {
    wirePayload.intervalType = data.intervalType;
  }
  if ("intervalValue" in changedFields && data.intervalValue && data.intervalValue.length > 0) {
    wirePayload.intervalValue = intervalValueToMinorUnits(intervalType, Number(data.intervalValue));
  }
  if ("status" in changedFields && data.status !== undefined) {
    wirePayload.status = data.status;
  }
  // lastServiceAt is a required DateTime on the model (not nullable), so it is
  // only sent when non-empty — clearing it is not a meaningful operation.
  if ("lastServiceAt" in changedFields && data.lastServiceAt && data.lastServiceAt.length > 0) {
    wirePayload.lastServiceAt = data.lastServiceAt;
  }
  // The meter anchors are nullable: "" → null (clear), a value → the integer.
  if ("lastServiceOdometerKm" in changedFields) {
    wirePayload.lastServiceOdometerKm =
      data.lastServiceOdometerKm && data.lastServiceOdometerKm.trim().length > 0
        ? Number(data.lastServiceOdometerKm)
        : null;
  }
  if ("lastServiceEngineHours" in changedFields) {
    wirePayload.lastServiceEngineHours =
      data.lastServiceEngineHours && data.lastServiceEngineHours.trim().length > 0
        ? hoursToTenths(Number(data.lastServiceEngineHours))
        : null;
  }

  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/service-schedules/${id}`, {
      method: "PATCH",
      json: wirePayload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/service-schedules");
  revalidatePath(`/service-schedules/${id}`);
  redirect(`/service-schedules/${id}`);
}

// deleteServiceScheduleAction — issues DELETE /api/v1/service-schedules/:id.
// Success (204) revalidates the list and redirects back. 404 is surfaced inline
// by the dialog (the row may already be gone). 409 surfaces the API's "Cannot
// delete service schedule: it is referenced by other records." message — a
// ServiceRecord still references the schedule (onDelete: Restrict). No `field`
// token: a delete-block is not a field-level error.
export async function deleteServiceScheduleAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/service-schedules/${id}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/service-schedules");
  redirect("/service-schedules");
}

// Re-derive the field token from status + message (apiFetch forwards neither the
// API's `field` body token nor anything beyond status + message).
function mapApiErrorToActionError(error: ApiError): ActionError {
  if (error.status === 409) {
    // The only unique constraint is @@unique([vehicleId, name]); a 409 is always
    // a duplicate name on the vehicle.
    return { ok: false, message: error.message, status: 409, field: "name" };
  }
  if (error.status === 400) {
    if (/metered in engine-hours|engine-hours service schedule/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "intervalType" };
    }
    if (/vehicle .* does not exist/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "vehicleId" };
    }
  }
  return { ok: false, message: error.message, status: error.status };
}
