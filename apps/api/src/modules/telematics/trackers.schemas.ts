import { z } from "zod";

// Zod schemas for the TrackerDevice CRUD slice (ADR-0042 M4). Mirrors the
// proven aggregate pattern (geofences.schemas.ts / drivers.schemas.ts): enum
// lists duplicated from the Prisma enum (so this validation file does NOT
// pull the Prisma runtime), `.strict()` on every object so a typo'd or
// server-controlled key surfaces as HTTP 400, comma-separated multi-value
// enum filters via `csvEnum`, and an explicit pagination ceiling mirrored
// from the service-side LIST_TAKE_MAX.

// TrackerStatus enum — must mirror TrackerStatus in prisma/schema.prisma.
// Order matches the Prisma enum so an audit grep finds both lists side by
// side. Duplicated as a const (not imported from @prisma/client) so this
// schema file stays runtime-free, the same convention every other
// aggregate's schema follows.
const TRACKER_STATUSES = ["ACTIVE", "SPARE", "RETIRED"] as const;
export type TrackerStatusName = (typeof TRACKER_STATUSES)[number];

// Whitelist of sortable columns. `status` has a @@index; the rest are cheap
// scalar sorts on a table whose row count is the physical device count
// (tens, not millions). `simMsisdn` is deliberately OFF the whitelist —
// ordering by a Tier-3 phone number has no operational use.
const SORTABLE_COLUMNS = ["createdAt", "imei", "status", "installedAt", "label"] as const;
export type TrackerSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type TrackerSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from trackers.service.ts on purpose: the
// service is the runtime authority; both constants move together.
const QUERY_MAX_TAKE = 200;

// The device IMEI — exactly 15 digits (the GSM/3GPP standard length; both
// the Teltonika FMC-series and the budget H02-class units report 15). The
// gateway identifies a unit by this string (ADR-0042 c9: it is the ONLY
// thing the open tracker port authenticates by), so the write surface is
// strict: no separators, no vendor prefixes, no 14- or 16-digit variants —
// a mistyped IMEI must fail HERE, not silently never match a forward.
const Imei = z
  .string()
  .trim()
  .regex(/^\d{15}$/, "IMEI must be exactly 15 digits.");

// Free-form operator label ("FMC920 unit 1", "spare — office drawer").
// Trimmed, non-empty when present; loose max like every other text field.
const Label = z.string().trim().min(1, "Label must not be empty.").max(256, "Label is too long.");

// The SIM's phone number (MSISDN, Tier 3). Deliberately loose — NTC/Ncell
// numbers are entered with or without +977 and the value is operator
// reference data (the number SMS commands are sent to), not a join key.
const SimMsisdn = z
  .string()
  .trim()
  .min(5, "SIM number is too short.")
  .max(32, "SIM number is too long.")
  .regex(/^\+?[0-9 -]+$/, "SIM number may contain only digits, spaces, dashes, and a leading +.");

const TrackerStatusEnum = z.enum(TRACKER_STATUSES, {
  error: () => `Status must be one of: ${TRACKER_STATUSES.join(", ")}.`,
});

// cuid shape for the `vehicleId` FK, identical to the geofences / fuel-logs
// `Cuid` helper. A stale-but-cuid-shaped id slips through to the service and
// fails the insert (Prisma P2003 → 400 with the vehicle named) there.
const Cuid = z
  .string()
  .trim()
  .min(1, "Required.")
  .regex(/^c[a-z0-9]{8,}$/i, "Must be a valid id.");

// `vehicleId` list filter: cuid-shaped, single value; empty string
// normalizes to undefined so the service omits the filter. Same shape as
// the geofences CuidFilter.
const CuidFilter = z
  .string()
  .optional()
  .transform((raw, ctx): string | undefined => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (!/^c[a-z0-9]{8,}$/i.test(trimmed)) {
      ctx.addIssue({ code: "custom", message: "Must be a valid id." });
      return z.NEVER;
    }
    return trimmed;
  });

// ISO-8601 date input for `installedAt`. Matches the Drivers/Vehicles
// convention (z.coerce.date()): accepts ISO strings, numeric timestamps,
// and Date instances.
const DateInput = z.coerce.date({
  error: (issue) =>
    issue.input === undefined
      ? "Date is required."
      : "Invalid date. Use an ISO-8601 date (YYYY-MM-DD).",
});

// Helper: single-string-or-comma-separated query value → validated,
// deduplicated array of enum members. Identical in shape to every other
// aggregate's csvEnum.
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  const member = z.enum(values);
  return z
    .string()
    .optional()
    .transform((raw, ctx): T[number][] | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return undefined;
      const seen = new Set<T[number]>();
      for (const part of parts) {
        const parsed = member.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({ code: "custom", message: `Must be one of: ${values.join(", ")}.` });
          return z.NEVER;
        }
        seen.add(parsed.data);
      }
      return Array.from(seen);
    });
}

// Coerce a string-typed query param to a bounded integer; out-of-range
// values return 400 rather than being silently clamped. Same helper shape
// as every other list schema.
function intParam(min: number, max: number, fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be an integer.` });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${min} or greater.` });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${max} or less.` });
        return z.NEVER;
      }
      return n;
    });
}

// GET /api/v1/telematics/trackers query parameters. Filter (status /
// vehicleId) + sort + pagination. `.strict()` so a typo'd query key
// surfaces as 400 rather than being silently ignored.
export const ListTrackersQuerySchema = z
  .object({
    status: csvEnum(TRACKER_STATUSES),
    vehicleId: CuidFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  .strict();

export type ListTrackersQuery = z.infer<typeof ListTrackersQuerySchema>;

// ---------------------------------------------------------------------------
// The retirement invariant (ADR-0042 c6).
// ---------------------------------------------------------------------------
//
// A RETIRED tracker must not hold a vehicle assignment: RETIRE is the
// lifecycle end (there is deliberately NO delete route — a device that
// existed stays in the register), and the `vehicleId @unique` slot must be
// freed for the replacement unit. The rule is NOT a database constraint, so
// it is enforced here on create (full shape present) and re-run by the
// service against the MERGED shape on PATCH — the same two-layer pattern as
// the geofence type/ownership invariant.

export interface TrackerLifecycleShape {
  status: TrackerStatusName;
  // null / undefined both mean "not mounted on a vehicle".
  vehicleId: string | null | undefined;
}

/**
 * Validate the tracker status/assignment invariant. Returns human-readable
 * error messages; an empty array means valid.
 *
 *   - RETIRED requires vehicleId to be null (unassign before retiring).
 */
export function validateTrackerLifecycle(shape: TrackerLifecycleShape): string[] {
  const errors: string[] = [];
  const mounted = shape.vehicleId !== null && shape.vehicleId !== undefined;
  if (shape.status === "RETIRED" && mounted) {
    errors.push("Unassign the tracker from its vehicle before retiring it.");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Write-path schemas — POST and PATCH bodies.
// ---------------------------------------------------------------------------
//
// Both `.strict()` so server-controlled keys (`id`, `createdById`,
// `createdAt`, `updatedAt`) are rejected on the wire with HTTP 400 rather
// than silently dropped. `createdById` is filled from the authenticated
// session (ADR-0021) and must never be accepted from the body.

/**
 * POST /api/v1/telematics/trackers body schema. Required: imei. Optional:
 * label, simMsisdn, status (defaults SPARE in the database), vehicleId
 * (assign at registration), installedAt. A duplicate IMEI or an
 * already-tracked vehicle surfaces as Prisma P2002 → 409 in the service.
 */
export const CreateTrackerSchema = z
  .object({
    imei: Imei,
    label: Label.nullable().optional(),
    simMsisdn: SimMsisdn.nullable().optional(),
    status: TrackerStatusEnum.optional(),
    vehicleId: Cuid.nullable().optional(),
    installedAt: DateInput.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The retirement invariant runs at the schema layer on create (the full
    // shape is present); on PATCH the service re-runs it against the merged
    // shape. Issues are pinned to `vehicleId` so the web form can highlight
    // the right input.
    for (const message of validateTrackerLifecycle({
      status: value.status ?? "SPARE",
      vehicleId: value.vehicleId ?? null,
    })) {
      ctx.addIssue({ code: "custom", message, path: ["vehicleId"] });
    }
  });

export type CreateTrackerInput = z.infer<typeof CreateTrackerSchema>;

/**
 * PATCH /api/v1/telematics/trackers/:id body schema. Every field optional
 * (diff-PATCH semantics). All five are mutable:
 *
 *   - `imei` — correct a mistyped registration (unique; P2002 → 409).
 *   - `label` / `simMsisdn` — relabel / SIM swap; explicit null clears.
 *   - `status` — lifecycle transitions (re-validated against the merged
 *     vehicleId: RETIRED requires unassigned).
 *   - `vehicleId` — assign / reassign; explicit `null` unassigns (frees the
 *     one-tracker-per-vehicle slot).
 *   - `installedAt` — the install date on the CURRENT vehicle; explicit
 *     null clears. When a PATCH changes `vehicleId` WITHOUT supplying
 *     `installedAt`, the service resets it to null (the stored date
 *     described the previous mount — see trackers.service.ts).
 *
 * The retirement invariant is NOT superRefined here — a partial body may
 * omit `status` (or `vehicleId`), so the rule is decided against the merged
 * shape in the service, mirroring the geofence ownership check.
 */
export const UpdateTrackerSchema = z
  .object({
    imei: Imei.optional(),
    label: Label.nullable().optional(),
    simMsisdn: SimMsisdn.nullable().optional(),
    status: TrackerStatusEnum.optional(),
    vehicleId: Cuid.nullable().optional(),
    installedAt: DateInput.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateTrackerInput = z.infer<typeof UpdateTrackerSchema>;
