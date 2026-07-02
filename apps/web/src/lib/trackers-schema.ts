import { z } from "zod";

// Web-side form schemas + display helpers for the TrackerDevice register
// (ADR-0042 M4). Mirrors the API's authoritative schemas
// (apps/api/src/modules/telematics/trackers.schemas.ts) at the field level.
// The API is authoritative; these give the operator immediate inline
// feedback before a round-trip. Duplication-budget rationale matches
// geofences-schema.ts / drivers-schema.ts: a shared workspace package is
// deferred; client drift is a UX cost, not a correctness one.

// TrackerStatus — mirrors the Prisma TrackerStatus enum + the API's
// TRACKER_STATUSES list. Single source of truth for the web side; the
// `Tracker` row type (app/trackers/types.ts) imports TrackerStatusName from
// here so a new status is added in one place.
export const TRACKER_STATUSES = ["ACTIVE", "SPARE", "RETIRED"] as const;
export type TrackerStatusName = (typeof TRACKER_STATUSES)[number];

// Display options for the <select>s and the label map. Single source of
// truth in the array; the label map is derived (mirror of
// GEOFENCE_TYPE_OPTIONS).
export const TRACKER_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "SPARE", label: "Spare" },
  { value: "RETIRED", label: "Retired" },
] as const;

export const TRACKER_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  TRACKER_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);

// Badge variant per status — ACTIVE is the "installed and expected to
// report" state (success); SPARE and RETIRED are inert states (neutral —
// the hue is recognition, the label is the meaning, DESIGN.md
// anti-pattern #2).
export const TRACKER_STATUS_BADGE_VARIANTS: Record<
  TrackerStatusName,
  "success" | "neutral" | "warning" | "error" | "info"
> = {
  ACTIVE: "success",
  SPARE: "neutral",
  RETIRED: "neutral",
};

// The device IMEI — exactly 15 digits, mirroring the API's Imei validator.
// The gateway identifies a unit by this string (ADR-0042 c9), so a
// mistyped IMEI must fail here rather than silently never matching a
// forward.
const Imei = z
  .string()
  .trim()
  .regex(/^\d{15}$/, "IMEI must be exactly 15 digits.");

// Free-form operator label. Empty string = "not provided" (the action
// omits / clears it).
const Label = z.string().trim().max(256, "Label is too long.");

// The SIM's MSISDN — loose, mirroring the API: digits/spaces/dashes and an
// optional leading +, or empty for "not provided".
const SimMsisdn = z
  .string()
  .trim()
  .max(32, "SIM number is too long.")
  .regex(
    /^\+?[0-9 -]{5,}$|^$/,
    "SIM number may contain only digits, spaces, dashes, and a leading +.",
  );

const TrackerStatusField = z.enum(TRACKER_STATUSES, {
  error: () => `Status must be one of: ${TRACKER_STATUSES.join(", ")}.`,
});

// installedAt as the YYYY-MM-DD string the NepaliDatePicker emits, or ""
// for "not set". The API coerces the string to a Date.
const InstalledAt = z.string().regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Use the YYYY-MM-DD date format.");

// The retirement invariant (ADR-0042 c6), mirrored client-side so the
// operator sees the contradiction immediately: a RETIRED tracker must not
// hold a vehicle assignment (RETIRE is the lifecycle end; the one-tracker-
// per-vehicle slot must be freed for the replacement unit). Pinned to the
// vehicleId path so the picker (not the whole form) shows the message. The
// API re-validates against the merged shape and remains authoritative.
function refineLifecycle(
  value: { status: TrackerStatusName; vehicleId?: string },
  ctx: z.RefinementCtx,
): void {
  const mounted = typeof value.vehicleId === "string" && value.vehicleId.length > 0;
  if (value.status === "RETIRED" && mounted) {
    ctx.addIssue({
      code: "custom",
      message: "Unassign the tracker from its vehicle before retiring it.",
      path: ["vehicleId"],
    });
  }
}

// Create form — required imei; everything else optional. "" from the
// vehicle picker means "spare / unassigned". The action strips empty
// strings out of the wire payload (the API's `.strict()` schemas reject
// empty-string stand-ins).
export const CreateTrackerFormSchema = z
  .object({
    imei: Imei,
    label: Label,
    simMsisdn: SimMsisdn,
    status: TrackerStatusField,
    vehicleId: z.string().optional(),
    installedAt: InstalledAt,
  })
  .superRefine((value, ctx) => refineLifecycle(value, ctx));

export type CreateTrackerFormValues = z.infer<typeof CreateTrackerFormSchema>;

// Update form — per-field optional (diff-PATCH semantics). No cross-field
// lifecycle refine here: a partial diff may carry only `status` or only
// `vehicleId`, so the rule is decided against the merged shape by the API
// service. The edit form's resolver uses the full CreateTrackerFormSchema
// for immediate client-side feedback against the visible shape; this
// schema validates the action's diff payload field-by-field.
export const UpdateTrackerFormSchema = z.object({
  imei: Imei.optional(),
  label: Label.optional(),
  simMsisdn: SimMsisdn.optional(),
  status: TrackerStatusField.optional(),
  vehicleId: z.string().optional(),
  installedAt: InstalledAt.optional(),
});

export type UpdateTrackerFormValues = z.infer<typeof UpdateTrackerFormSchema>;
