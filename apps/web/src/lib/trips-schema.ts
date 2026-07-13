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

const TRIP_STATUSES = [
  "PLANNED",
  "OFFERED",
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

// Haulage material (ADR-0047 c5). Mirrors the API's MaterialType Prisma enum and
// the web MATERIAL_TYPE_OPTIONS in trips/types.ts — all three move together.
const MATERIAL_TYPES = [
  "SAND",
  "AGGREGATE",
  "GRAVEL",
  "STONE",
  "BOULDER",
  "SOIL",
  "BRICKS",
  "OTHER",
] as const;
// Meter type (ADR-0036) — mirrors the API's MeterType. A derived form field,
// synced from the selected vehicle, that drives which reading(s) the cross-field
// rule requires. Never sent on the wire (the trip body has no meterType).
const METER_TYPES = ["ODOMETER_KM", "ENGINE_HOURS", "BOTH"] as const;

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

// Engine-hours reading (ADR-0036): a DECIMAL number of hours (e.g. "1234.5"),
// at most one decimal place (the hour-meter's 0.1 h resolution). Empty means
// "not set". The action layer converts a non-empty value to integer tenths via
// hoursToTenths (units.ts). Mirror of vehicles-schema.ts's OptionalHoursString.
const HoursString = z.string().regex(/^$|^\d+(\.\d)?$/, {
  message: "Enter hours as a number with at most one decimal (e.g. 1234.5).",
});

// Expected load count: a whole number of loads, entered in an HTML number input
// (returns a string). Empty means "not set". The action layer converts a
// non-empty value to an integer; the API enforces the 1..100_000 bound.
const LoadCountString = z.string().regex(/^\d{0,6}$|^$/, {
  message: "Enter a whole number of loads.",
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
    // Engine-hours readings (ADR-0036), decimal-hours strings. Captured only
    // for an hour-metered vehicle; the action layer converts to integer tenths.
    startEngineHours: HoursString.optional(),
    endEngineHours: HoursString.optional(),
    // Derived: the selected vehicle's meter, synced by the form's vehicle
    // picker. Drives the meter-aware required-reading rule below. Not sent on
    // the wire — the trip body has no meterType; the API re-derives it from the
    // vehicle (TripsService cross-field re-validation).
    meterType: z.enum(METER_TYPES),
    notes: z.string().max(1000, "Notes cap is 1000 characters.").optional(),
    // Haulage order (ADR-0047 c3/c5). All optional at the form layer; the
    // OFFERED-order cross-field rule below requires material + pickup + drop-off
    // when status is OFFERED (mirroring the API's authoritative rule). The action
    // layer omits empty strings and converts expectedLoadCount to an integer.
    materialType: z.string().optional(),
    materialNote: z.string().max(500, "Material note cap is 500 characters.").optional(),
    pickupSiteId: z.string().optional(),
    dropoffSiteId: z.string().optional(),
    consigneeName: z.string().max(200, "Consignee name cap is 200 characters.").optional(),
    consigneePhone: z.string().max(40, "Consignee phone cap is 40 characters.").optional(),
    expectedLoadCount: LoadCountString.optional(),
    specialInstructions: z
      .string()
      .max(1000, "Special instructions cap is 1000 characters.")
      .optional(),
    docketNumber: z.string().max(100, "Docket number cap is 100 characters.").optional(),
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
  startEngineHours?: string;
  endEngineHours?: string;
  meterType?: (typeof METER_TYPES)[number];
  // Order fields the OFFERED-order rule reads (ADR-0047 c3).
  materialType?: string;
  materialNote?: string;
  pickupSiteId?: string;
  dropoffSiteId?: string;
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

// Which reading(s) the selected meter requires (ADR-0036 c7), mirroring the
// API's rule. An undefined meterType (no vehicle picked yet) defaults to
// odometer — the safe default and the create form's initial state.
function meterRequiresOdometer(meterType?: string): boolean {
  return meterType !== "ENGINE_HOURS"; // ODOMETER_KM, BOTH, undefined → true
}
function meterRequiresHours(meterType?: string): boolean {
  return meterType === "ENGINE_HOURS" || meterType === "BOTH";
}

// IN_PROGRESS requires startedAt + the meter's start reading (km / hours / both).
function checkInProgressShape(
  data: TripFormRefineInput,
): { ok: true } | { ok: false; path: string; message: string } {
  if (data.status !== "IN_PROGRESS") return { ok: true };
  if (!isPresent(data.startedAt)) {
    return { ok: false, path: "startedAt", message: "IN_PROGRESS trip needs a start time." };
  }
  if (meterRequiresOdometer(data.meterType) && !isPresent(data.startOdometerKm)) {
    return {
      ok: false,
      path: "startOdometerKm",
      message: "IN_PROGRESS trip needs a start odometer reading.",
    };
  }
  if (meterRequiresHours(data.meterType) && !isPresent(data.startEngineHours)) {
    return {
      ok: false,
      path: "startEngineHours",
      message: "IN_PROGRESS trip needs a start engine-hours reading.",
    };
  }
  return { ok: true };
}

// COMPLETED requires startedAt + endedAt and the meter's start AND end readings,
// with end >= start on whichever reading pair(s) are present.
function checkCompletedShape(
  data: TripFormRefineInput,
): { ok: true } | { ok: false; path: string; message: string } {
  if (data.status !== "COMPLETED") return { ok: true };
  if (!isPresent(data.startedAt))
    return { ok: false, path: "startedAt", message: "COMPLETED trip needs a start time." };
  if (!isPresent(data.endedAt))
    return { ok: false, path: "endedAt", message: "COMPLETED trip needs an end time." };
  if (meterRequiresOdometer(data.meterType)) {
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
  }
  if (meterRequiresHours(data.meterType)) {
    if (!isPresent(data.startEngineHours))
      return {
        ok: false,
        path: "startEngineHours",
        message: "COMPLETED trip needs a start engine-hours reading.",
      };
    if (!isPresent(data.endEngineHours))
      return {
        ok: false,
        path: "endEngineHours",
        message: "COMPLETED trip needs an end engine-hours reading.",
      };
  }
  // end >= start for whichever reading pair is present (compare numerically).
  if (isPresent(data.startOdometerKm) && isPresent(data.endOdometerKm)) {
    if (Number(data.endOdometerKm) < Number(data.startOdometerKm)) {
      return {
        ok: false,
        path: "endOdometerKm",
        message: "End odometer must be >= start odometer.",
      };
    }
  }
  if (isPresent(data.startEngineHours) && isPresent(data.endEngineHours)) {
    if (Number(data.endEngineHours) < Number(data.startEngineHours)) {
      return {
        ok: false,
        path: "endEngineHours",
        message: "End engine-hours must be >= start engine-hours.",
      };
    }
  }
  // Compare lexicographically for datetime-local strings (sortable as
  // strings because the format is fixed-width).
  if (data.startedAt && data.endedAt && data.endedAt < data.startedAt) {
    return { ok: false, path: "endedAt", message: "End time must be >= start time." };
  }
  return { ok: true };
}

// OFFERED requires the order (material + pickup + drop-off), mirroring the API's
// authoritative rule (ADR-0047 c3); at OFFERED an "Other" material also needs its
// free-text note. A chosen material must ALWAYS be a known type. The order is
// unconstrained before OFFERED — a PLANNED draft carries whatever the operator
// has filled so far, and an externally-created OFFERED-Other trip with no note
// (which the API accepts) stays editable rather than being locked behind the note.
function checkOfferedOrderShape(
  data: TripFormRefineInput,
): { ok: true } | { ok: false; path: string; message: string } {
  if (
    isPresent(data.materialType) &&
    !(MATERIAL_TYPES as readonly string[]).includes(data.materialType as string)
  ) {
    return { ok: false, path: "materialType", message: "Pick a valid material." };
  }
  if (data.status === "OFFERED") {
    if (!isPresent(data.materialType)) {
      return { ok: false, path: "materialType", message: "An offered trip needs a material." };
    }
    if (!isPresent(data.pickupSiteId)) {
      return { ok: false, path: "pickupSiteId", message: "An offered trip needs a pickup site." };
    }
    if (!isPresent(data.dropoffSiteId)) {
      return {
        ok: false,
        path: "dropoffSiteId",
        message: "An offered trip needs a drop-off site.",
      };
    }
    // A dispatched "Other" material needs its free-text note to say what it is.
    // Gated on OFFERED (not every status) so a PLANNED draft stays unconstrained
    // and an externally-created OFFERED-Other trip without a note is still
    // editable — the API never requires this note, it is a dispatch-time nicety.
    if (data.materialType === "OTHER" && !isPresent(data.materialNote)) {
      return {
        ok: false,
        path: "materialNote",
        message: "Describe the material when it is Other.",
      };
    }
  }
  return { ok: true };
}

// Superrefine that applies the IN_PROGRESS, COMPLETED, and OFFERED-order
// cross-field rules. Shared between the create and update schemas via direct
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
  const offeredCheck = checkOfferedOrderShape(input);
  if (!offeredCheck.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [offeredCheck.path],
      message: offeredCheck.message,
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
