"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@/lib/api";
import {
  CreateFuelLogFormSchema,
  UpdateFuelLogFormSchema,
  litersToMl,
  rupeesToPaisa,
  type CreateFuelLogFormInput,
  type UpdateFuelLogFormInput,
} from "@/lib/fuel-logs-schema";

// Server actions for the Fuel-logs write path (iter 20) — create,
// update, delete. All three call apiFetch from the server context
// (cookies forward automatically) and reshape API errors into a
// structured result the client can render inline. Success paths use
// Next.js's redirect, which throws NEXT_REDIRECT and is caught by the
// framework as a navigation, NOT as a real error.
//
// Mirror of apps/web/src/app/jobs/actions.ts in shape, conventions,
// and error model. Differences vs Jobs:
//   - the create surface collects vehicleId (a picker) and tripId (an
//     optional picker scoped to that vehicle); the API rejects
//     totalCostPaisa / createdById entirely (server-derived);
//   - the update surface forbids vehicleId on the wire (immutable;
//     the API's .strict() rejects it) but allows tripId;
//   - on success of create we redirect to /fuel-logs/<id> (back to
//     the new fuel log's detail page);
//   - the action layer performs the human-units → integer conversion
//     (liters decimal → mL integer, rupees decimal → paisa integer)
//     before posting. The schema validates the decimal bounds; this
//     layer multiplies by 1000 / 100 and rounds.
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
  // from auth failures (401). 409 is not reachable today (FuelLog has
  // no unique columns aside from `id`).
  status: number;
  // Optional field path so the create / edit form can surface a
  // vehicleId / tripId 400 inline against the right picker.
  field?: string;
}

// createFuelLogAction — POSTs a new fuel log. The client form gives
// us the raw form input (CreateFuelLogFormInput — every field a
// string); we re-validate server-side via the same schema (defense in
// depth), convert the decimal liters + price into integer mL + paisa,
// then POST. On success the function calls redirect("/fuel-logs/<id>")
// which throws NEXT_REDIRECT.
//
// 400 with the customer-not-found / trip-mismatch phrasing surfaces
// as a field-level error so the form can highlight the right picker.
export async function createFuelLogAction(
  values: CreateFuelLogFormInput,
): Promise<ActionError | never> {
  const parsed = CreateFuelLogFormSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Build the wire payload. Required: vehicleId, date, litersMl,
  // pricePerLiterPaisa. Optional: tripId, odometerReadingKm, station,
  // receiptNumber, notes. We OMIT optional fields when they are
  // unset rather than sending null — the API's POST schema does not
  // require nulls for absent optionals.
  const body: Record<string, unknown> = {
    vehicleId: parsed.data.vehicleId,
    date: parsed.data.date,
    litersMl: litersToMl(parsed.data.liters),
    pricePerLiterPaisa: rupeesToPaisa(parsed.data.pricePerLiter),
  };
  if (parsed.data.tripId && parsed.data.tripId.length > 0) {
    body.tripId = parsed.data.tripId;
  }
  if (parsed.data.odometerReadingKm !== undefined) {
    body.odometerReadingKm = parsed.data.odometerReadingKm;
  }
  if (parsed.data.station !== undefined) {
    body.station = parsed.data.station;
  }
  if (parsed.data.receiptNumber !== undefined) {
    body.receiptNumber = parsed.data.receiptNumber;
  }
  if (parsed.data.notes !== undefined) {
    body.notes = parsed.data.notes;
  }

  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>("/api/v1/fuel-logs", {
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

  revalidatePath("/fuel-logs");
  redirect(`/fuel-logs/${created.id}`);
}

// updateFuelLogAction — patches only the fields that actually changed
// vs. the user's initial form values. The caller (edit-fuel-log-form)
// computes that diff client-side before invoking this action, so the
// payload never re-sends a field the user didn't touch.
//
// vehicleId is intentionally NOT in UpdateFuelLogFormInput — immutable;
// the API's .strict() rejects it. tripId IS — mutable.
//
// Returns ActionError on failure; throws NEXT_REDIRECT on success.
export async function updateFuelLogAction(
  id: string,
  changedFields: Partial<UpdateFuelLogFormInput>,
): Promise<ActionError | never> {
  if (Object.keys(changedFields).length === 0) {
    return { ok: false, message: "Nothing to update.", status: 400 };
  }

  const parsed = UpdateFuelLogFormSchema.safeParse(changedFields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "form"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: issues, status: 400 };
  }

  // Translate the form's resolved values into the API's wire shape.
  // For mutable nullable fields (tripId, odometerReadingKm, station,
  // receiptNumber, notes), empty / undefined → null on the wire (the
  // explicit "clear" signal the service-layer hasOwnProperty branch
  // consumes). For the integer-converted fields (liters, price), we
  // multiply through and rename to the API's keys.
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

  if ("liters" in changedFields && parsed.data.liters !== undefined) {
    wirePayload.litersMl = litersToMl(parsed.data.liters);
  }

  if ("pricePerLiter" in changedFields && parsed.data.pricePerLiter !== undefined) {
    wirePayload.pricePerLiterPaisa = rupeesToPaisa(parsed.data.pricePerLiter);
  }

  if ("odometerReadingKm" in changedFields) {
    wirePayload.odometerReadingKm =
      parsed.data.odometerReadingKm !== undefined ? parsed.data.odometerReadingKm : null;
  }

  if ("station" in changedFields) {
    wirePayload.station = parsed.data.station !== undefined ? parsed.data.station : null;
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

  try {
    await apiFetch<unknown>(`/api/v1/fuel-logs/${id}`, {
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

  revalidatePath("/fuel-logs");
  revalidatePath(`/fuel-logs/${id}`);
  redirect(`/fuel-logs/${id}`);
}

// deleteFuelLogAction — issues DELETE /api/v1/fuel-logs/:id. Success
// (HTTP 204) revalidates the list and redirects back to it. 404 is
// surfaced inline by the dialog (the row may have been deleted by
// another session between the dialog opening and the confirm click).
// No 409 today — FuelLog is a leaf aggregate (no inbound FKs).
export async function deleteFuelLogAction(id: string): Promise<ActionError | never> {
  try {
    await apiFetch<void>(`/api/v1/fuel-logs/${id}`, { method: "DELETE" });
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

  revalidatePath("/fuel-logs");
  redirect("/fuel-logs");
}

// Map an ApiError into an ActionError with a field token when the
// message identifies a specific picker. The trip-vehicle mismatch
// message comes from FuelLogsService.assertTripBelongsToVehicle and
// reads "Trip <reg> belongs to vehicle <reg>; cannot pair with a fuel
// log for vehicle <reg>." The Vehicle / Trip not-found messages come
// from the P2003 mapper and read "Vehicle <id> does not exist." /
// "Trip <id> does not exist." We pattern-match on those substrings to
// route to the right picker. Any other 400 falls through to the
// generic banner.
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
