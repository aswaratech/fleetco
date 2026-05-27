import { z } from "zod";

// Web-side form schemas for the Trips write path (iter 9). Mirrors the
// API's `CreateTripSchema` / `UpdateTripSchema` in
// apps/api/src/modules/trips/trips.schemas.ts at the field level and at
// the cross-field-rule level. Drift is bounded — the API rejects
// anything the client sends incorrectly — but matching client-side
// gives the operator immediate inline feedback rather than a server
// round-trip.
//
// Same duplication-budget rationale as drivers-schema.ts: a shared
// workspace package is deferred until the third aggregate needs a form
// schema; today the duplication cost is one ~120-line file per slice.
//
// Date / time inputs from `<input type="datetime-local">` return
// `YYYY-MM-DDTHH:MM` strings (no seconds, no timezone). The action
// layer appends `:00Z` to make a valid ISO string before POSTing, so
// the form schemas accept the raw datetime-local shape; `string()
// .regex(...)` keeps validation honest. Empty string means "not set"
// for the optional / nullable fields.

const TRIP_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;

// `<input type="datetime-local">` value format. Accepts `YYYY-MM-DDTHH:MM`
// or empty string. The action layer turns empty → undefined and
// non-empty → ISO via `${value}:00Z`. Tighter regex tightening should
// happen at the API layer (CreateTripSchema's `z.coerce.date()`); the
// form regex stays loose so a Firefox quirk that emits `YYYY-MM-DDTHH:MM:SS`
// instead of `YYYY-MM-DDTHH:MM` still passes the client check.
const DateTimeLocalString = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$|^$/, {
  message: "Use the YYYY-MM-DDTHH:MM datetime format.",
});

// Odometer reading: 0..9_999_999 km. Empty input means "not set".
// Stored as an unsigned int on the API side. We accept the input as
// string (HTML number inputs come back as strings) and coerce via
// the action layer; the form-side regex check is just a sanity gate.
const OdometerString = z.string().regex(/^\d{0,7}$|^$/, {
  message: "Enter a whole number of kilometers (0–9,999,999).",
});

// Shared field shape for the create and update forms. The cross-field
// rules around status × timing × odometer are encoded as `.refine`s on
// each derived schema so the same constraint set runs at the schema
// boundary on both create and update paths.
//
// (Note: an .superRefine is more flexible than .refine but produces
// less-readable issue paths; the cross-field rules below stay narrow
// enough that several focused .refines beat one omnibus check.)
function buildTripFormShape() {
  return {
    vehicleId: z.string().min(1, "Pick a vehicle."),
    driverId: z.string().min(1, "Pick a driver."),
    status: z.enum(TRIP_STATUSES),
    startedAt: DateTimeLocalString.optional(),
    endedAt: DateTimeLocalString.optional(),
    startOdometerKm: OdometerString.optional(),
    endOdometerKm: OdometerString.optional(),
    notes: z.string().max(1000, "Notes cap is 1000 characters.").optional(),
  };
}

// Common cross-field rules. Returns an array of refine functions that
// can be chained onto either schema. Each rule receives the parsed
// object and returns `true` on pass or `false` on fail; the issue
// shape names the offending field so the form can surface the message
// in the right place.
interface TripFormRefineInput {
  status: (typeof TRIP_STATUSES)[number];
  startedAt?: string;
  endedAt?: string;
  startOdometerKm?: string;
  endOdometerKm?: string;
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

// IN_PROGRESS requires startedAt + startOdometerKm. Mirrors the
// CreateTripSchema cross-field rule.
function checkInProgressShape(
  data: TripFormRefineInput,
): { ok: true } | { ok: false; path: string; message: string } {
  if (data.status !== "IN_PROGRESS") return { ok: true };
  if (!isPresent(data.startedAt)) {
    return { ok: false, path: "startedAt", message: "IN_PROGRESS trip needs a start time." };
  }
  if (!isPresent(data.startOdometerKm)) {
    return {
      ok: false,
      path: "startOdometerKm",
      message: "IN_PROGRESS trip needs a start odometer reading.",
    };
  }
  return { ok: true };
}

// COMPLETED requires all four start/end fields, and end >= start on both.
function checkCompletedShape(
  data: TripFormRefineInput,
): { ok: true } | { ok: false; path: string; message: string } {
  if (data.status !== "COMPLETED") return { ok: true };
  if (!isPresent(data.startedAt))
    return { ok: false, path: "startedAt", message: "COMPLETED trip needs a start time." };
  if (!isPresent(data.endedAt))
    return { ok: false, path: "endedAt", message: "COMPLETED trip needs an end time." };
  if (!isPresent(data.startOdometerKm))
    return {
      ok: false,
      path: "startOdometerKm",
      message: "COMPLETED trip needs a start odometer reading.",
    };
  if (!isPresent(data.endOdometerKm))
    return {
      ok: false,
      path: "endOdometerKm",
      message: "COMPLETED trip needs an end odometer reading.",
    };
  // Compare numerically (both strings of digits).
  const start = Number(data.startOdometerKm);
  const end = Number(data.endOdometerKm);
  if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
    return {
      ok: false,
      path: "endOdometerKm",
      message: "End odometer must be >= start odometer.",
    };
  }
  // Compare lexicographically for datetime-local strings (sortable as
  // strings because the format is fixed-width).
  if (data.startedAt && data.endedAt && data.endedAt < data.startedAt) {
    return { ok: false, path: "endedAt", message: "End time must be >= start time." };
  }
  return { ok: true };
}

// Superrefine that applies the IN_PROGRESS and COMPLETED cross-field
// rules. Shared between the create and update schemas via direct
// invocation (no wrapper helper) because zod 4 typing makes a generic
// helper awkward — `.superRefine` returns the original schema's type,
// and the inferred return is what we want for `z.infer`.
function tripCrossFieldRules(data: unknown, ctx: z.RefinementCtx): void {
  const input = data as TripFormRefineInput;
  const inProgressCheck = checkInProgressShape(input);
  if (!inProgressCheck.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [inProgressCheck.path],
      message: inProgressCheck.message,
    });
  }
  const completedCheck = checkCompletedShape(input);
  if (!completedCheck.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [completedCheck.path],
      message: completedCheck.message,
    });
  }
}

// Create form: all primary fields required (vehicleId, driverId,
// status); timing + odometer + notes optional unless status requires
// them. Defaults `status` to PLANNED in the form's defaultValues but
// the schema still requires it explicitly so we cannot send an
// undefined / empty status to the API.
export const CreateTripFormSchema = z.object(buildTripFormShape()).superRefine(tripCrossFieldRules);
export type CreateTripFormValues = z.infer<typeof CreateTripFormSchema>;

// Update form: every field optional (PATCH semantics). The cross-field
// rules still apply when the relevant fields are present — e.g., if
// the operator changes status to COMPLETED, the merged shape must have
// all four start/end fields. The edit form layer is responsible for
// merging the partial update with the initial values before running
// validation; see edit-trip-form.tsx.
export const UpdateTripFormSchema = z
  .object(buildTripFormShape())
  .partial()
  .superRefine(tripCrossFieldRules);
export type UpdateTripFormValues = z.infer<typeof UpdateTripFormSchema>;
