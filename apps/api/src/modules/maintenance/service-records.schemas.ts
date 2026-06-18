import { z } from "zod";

// Zod schemas for the ServiceRecord aggregate (ADR-0037 / Program B, B3). A
// ServiceRecord is a completed service event — the maintenance history. It
// carries the meter reading(s) captured at service + a performedAt date, an
// optional link to the ServiceSchedule it satisfies (null for an ad-hoc /
// one-off service), and optional notes. Unlike ServiceSchedule there is NO
// unique constraint (the same vehicle can legitimately be serviced twice on one
// day), so no P2002 path; the only write error is a stale FK (P2003 → 400).
//
// Mirrors the proven aggregate pattern (fuel-logs / customers): enum-free here
// (records carry no enum), `.strict()` on every object, cuid FK helpers, and an
// explicit pagination ceiling. The schedule↔record vehicle-match consistency
// check (ADR-0037 c5: a record's schedule must belong to the same vehicle)
// needs a DB lookup and so lives at the service layer.

const SORTABLE_COLUMNS = ["performedAt", "createdAt"] as const;
export type ServiceRecordSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type ServiceRecordSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from service-records.service.ts on purpose.
const QUERY_MAX_TAKE = 200;

// Integer-minor-units bounds. Meter readings are non-negative integers; the
// 100M ceiling is the odometer convention (catches an accidental unit paste).
const METER_READING_MIN = 0;
const METER_READING_MAX = 100_000_000;
const NOTES_MAX = 4096;

const OdometerKm = z
  .number({ error: () => "odometerKm must be an integer." })
  .int("odometerKm must be an integer.")
  .min(METER_READING_MIN, `odometerKm must be ${METER_READING_MIN} or greater.`)
  .max(METER_READING_MAX, `odometerKm must be ${METER_READING_MAX} or less.`);

const EngineHours = z
  .number({ error: () => "engineHours must be an integer (tenths of an hour)." })
  .int("engineHours must be an integer (tenths of an hour).")
  .min(METER_READING_MIN, `engineHours must be ${METER_READING_MIN} or greater.`)
  .max(METER_READING_MAX, `engineHours must be ${METER_READING_MAX} or less.`);

const Notes = z.string().max(NOTES_MAX, `Notes must be at most ${NOTES_MAX} characters.`);

// `performedAt` accepts YYYY-MM-DD or ISO 8601 strings (and any value
// `new Date(...)` can parse). The coerced Date reaches the service. Mirror of
// the fuel-logs / jobs date helpers. Required on create (a service event must
// have happened at a known time).
const PerformedAt = z.coerce.date({
  error: () => "performedAt must be a valid date (YYYY-MM-DD or ISO 8601).",
});

// cuid shape for the FK ids, identical to the fuel-logs / geofences `Cuid`
// helper. A stale-but-cuid-shaped id slips to the service and fails the insert
// (Prisma P2003 → 400), or is caught by the schedule-vehicle consistency check.
const Cuid = z
  .string()
  .trim()
  .min(1, "Required.")
  .regex(/^c[a-z0-9]{8,}$/i, "Must be a valid id.");

// `vehicleId` / `serviceScheduleId` list filters: cuid-shaped, single value. An
// empty string normalizes to `undefined` so the service omits the filter rather
// than asking Prisma for `where = ''`. Same shape as the fuel-logs CuidFilter.
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

// Coerce a string query param to a bounded non-negative integer. Out-of-range
// values return 400 with a clear message rather than being silently clamped.
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

// GET /api/v1/service-records query parameters. Filter (vehicleId /
// serviceScheduleId) + sort + pagination. `.strict()` so a typo'd query key
// surfaces as 400. Default sort is performedAt desc ("most recent service
// first").
export const ListServiceRecordsQuerySchema = z
  .object({
    vehicleId: CuidFilter,
    serviceScheduleId: CuidFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  .strict();

export type ListServiceRecordsQuery = z.infer<typeof ListServiceRecordsQuerySchema>;

// POST /api/v1/service-records body. Required: vehicleId, performedAt. Optional:
// serviceScheduleId (nullable — an ad-hoc service has no schedule), expenseLogId
// (nullable — a warranty service has no cost, or the invoice isn't keyed yet),
// odometerKm, engineHours, notes. `createdById` is NOT accepted from the client
// — the controller pulls it from the session; `.strict()` rejects it. The
// expenseLogId consistency check (B4: the referenced expense must be
// MAINTENANCE/REPAIR and on the same vehicle, ADR-0037 c6) needs a DB lookup and
// so lives at the service layer, not here.
export const CreateServiceRecordSchema = z
  .object({
    vehicleId: Cuid,
    serviceScheduleId: Cuid.nullable().optional(),
    expenseLogId: Cuid.nullable().optional(),
    performedAt: PerformedAt,
    odometerKm: OdometerKm.nullable().optional(),
    engineHours: EngineHours.nullable().optional(),
    notes: Notes.nullable().optional(),
  })
  .strict();

export type CreateServiceRecordInput = z.infer<typeof CreateServiceRecordSchema>;

// PATCH /api/v1/service-records/:id — partial update. Every mutable field is
// optional (diff-PATCH semantics). `vehicleId` is NOT in the shape and so
// `.strict()` rejects it: a record states which vehicle was serviced, immutable
// like the fuel-logs / expense-logs vehicleId. `serviceScheduleId` IS mutable —
// linking / unlinking an ad-hoc record to a schedule after the fact is a
// routine correction (mirror of the fuel-logs mutable tripId), re-validated for
// the vehicle-match against the stored vehicle. `expenseLogId` is likewise
// mutable — attaching the cost invoice after the fact is the same routine
// correction, re-validated as a same-vehicle MAINTENANCE/REPAIR expense. The
// empty-body refine rejects a no-op PATCH as 400.
export const UpdateServiceRecordSchema = z
  .object({
    serviceScheduleId: Cuid.nullable().optional(),
    expenseLogId: Cuid.nullable().optional(),
    performedAt: PerformedAt.optional(),
    odometerKm: OdometerKm.nullable().optional(),
    engineHours: EngineHours.nullable().optional(),
    notes: Notes.nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateServiceRecordInput = z.infer<typeof UpdateServiceRecordSchema>;
