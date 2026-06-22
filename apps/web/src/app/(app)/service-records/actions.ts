"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateServiceRecordFormSchema,
  UpdateServiceRecordFormSchema,
  hoursToTenths,
  type CreateServiceRecordFormValues,
  type UpdateServiceRecordFormValues,
} from "@/lib/service-records-schema";

// Server actions for the ServiceRecord write path (ADR-0037 B5) — create,
// update, delete. All three call apiFetch from the server context (cookies
// forward automatically) and reshape API errors into a structured result the
// client can render inline. Success paths use Next.js's redirect (throws
// NEXT_REDIRECT, caught by the framework as a navigation). Mirror of
// apps/web/src/app/expense-logs/actions.ts in shape + error model.
//
// Meter conversions at the boundary: odometer is already integer km; engine
// hours are entered as decimal hours and converted to integer tenths via the
// shipped `hoursToTenths`. Optional links (serviceScheduleId, expenseLogId) and
// readings are OMITTED on create when blank; on update, a present-but-empty
// nullable field clears it (wire null).
//
// Field-token routing (mapApiErrorToActionError): apiFetch forwards only status
// + message, so the field is re-derived from the 400 message. The three
// consistency-rule message groups are disjoint — "expense log …" → expenseLogId,
// "service schedule …" → serviceScheduleId, "vehicle … does not exist" →
// vehicleId — so substring routing is unambiguous.

export interface ActionError {
  ok: false;
  message: string;
  status: number;
  // Optional field path: "expenseLogId" (cost-link 400), "serviceScheduleId"
  // (schedule-vehicle mismatch / stale 400), or "vehicleId" (stale-FK 400).
  field?: string;
}

// createServiceRecordAction — POSTs a new record. Re-validates server-side,
// converts the readings, then POSTs. Redirects to the new record's detail page.
export async function createServiceRecordAction(
  values: CreateServiceRecordFormValues,
): Promise<ActionError | never> {
  const parsed = CreateServiceRecordFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }
  const data = parsed.data;

  const body: Record<string, unknown> = {
    vehicleId: data.vehicleId,
    performedAt: data.performedAt,
  };
  if (data.serviceScheduleId && data.serviceScheduleId.length > 0) {
    body.serviceScheduleId = data.serviceScheduleId;
  }
  if (data.expenseLogId && data.expenseLogId.length > 0) {
    body.expenseLogId = data.expenseLogId;
  }
  if (data.odometerKm && data.odometerKm.trim().length > 0) {
    body.odometerKm = Number(data.odometerKm);
  }
  if (data.engineHours && data.engineHours.trim().length > 0) {
    body.engineHours = hoursToTenths(Number(data.engineHours));
  }
  if (data.notes && data.notes.trim().length > 0) {
    body.notes = data.notes.trim();
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/service-records", {
      method: "POST",
      json: body,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/service-records");
  redirect(`/service-records/${created.id}`);
}

// updateServiceRecordAction — patches only the changed fields. vehicleId is
// immutable (not in the form schema). Mutable nullable links / readings: a key
// present in the diff with "" → wire null (clear); a value → the converted
// integer.
export async function updateServiceRecordAction(
  id: string,
  changedFields: Partial<UpdateServiceRecordFormValues>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateServiceRecordFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }
  const data = parsed.data;

  const wirePayload: Record<string, unknown> = {};
  if ("serviceScheduleId" in changedFields) {
    wirePayload.serviceScheduleId =
      data.serviceScheduleId && data.serviceScheduleId.length > 0 ? data.serviceScheduleId : null;
  }
  if ("expenseLogId" in changedFields) {
    wirePayload.expenseLogId =
      data.expenseLogId && data.expenseLogId.length > 0 ? data.expenseLogId : null;
  }
  // performedAt is a required DateTime — only sent when non-empty.
  if ("performedAt" in changedFields && data.performedAt && data.performedAt.length > 0) {
    wirePayload.performedAt = data.performedAt;
  }
  if ("odometerKm" in changedFields) {
    wirePayload.odometerKm =
      data.odometerKm && data.odometerKm.trim().length > 0 ? Number(data.odometerKm) : null;
  }
  if ("engineHours" in changedFields) {
    wirePayload.engineHours =
      data.engineHours && data.engineHours.trim().length > 0
        ? hoursToTenths(Number(data.engineHours))
        : null;
  }
  if ("notes" in changedFields) {
    wirePayload.notes = data.notes && data.notes.trim().length > 0 ? data.notes.trim() : null;
  }

  if (Object.keys(wirePayload).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  try {
    await apiFetch<unknown>(`/api/v1/service-records/${id}`, {
      method: "PATCH",
      json: wirePayload,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return mapApiErrorToActionError(error);
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/service-records");
  revalidatePath(`/service-records/${id}`);
  redirect(`/service-records/${id}`);
}

// deleteServiceRecordAction — issues DELETE /api/v1/service-records/:id. Success
// (204) revalidates the list and redirects back. 404 is surfaced inline by the
// dialog (the row may already be gone). Nothing FKs INTO a ServiceRecord, so
// there is no 409 delete-block.
export async function deleteServiceRecordAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/service-records/${id}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message, status: error.status };
    }
    return { ok: false, message: "Could not reach the FleetCo API. Try again.", status: 0 };
  }

  revalidatePath("/service-records");
  redirect("/service-records");
}

// Re-derive the field token from the 400 message. The consistency-rule messages
// are disjoint: the cost-link checks all name "expense log"; the schedule checks
// all name "service schedule"; the stale-vehicle FK names "vehicle … does not
// exist". Checked in that order so the schedule-belongs-to-a-different-vehicle
// message (which contains the word "vehicle") still routes to the schedule
// picker, not the vehicle one.
function mapApiErrorToActionError(error: ApiError): ActionError {
  if (error.status === 400) {
    if (/expense log/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "expenseLogId" };
    }
    if (/service schedule/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "serviceScheduleId" };
    }
    if (/vehicle .* does not exist/i.test(error.message)) {
      return { ok: false, message: error.message, status: 400, field: "vehicleId" };
    }
  }
  return { ok: false, message: error.message, status: error.status };
}
