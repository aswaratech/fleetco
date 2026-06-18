import { z } from "zod";

// Zod schemas for the NotificationLog READ path (ADR-0038 C4). The
// NotificationLog is the send-once dedup ledger AND the audit trail
// (ADR-0038 c5: "we notified about that lapse on date X" is a fact the system
// can produce, the ADR-0013 audit value). This slice makes that ledger VISIBLE
// as a read-only history surface; there is NO write path — the ledger is
// append-only and written ONLY by the scan→send worker (NotificationService),
// never by an HTTP client.
//
// This file deliberately mirrors customers.schemas.ts / geofences.schemas.ts in
// shape and convention: `.strict()` to reject unknown keys with HTTP 400, the
// `intParam` coerced-bounds helper, the `DateFilter` coerced-date helper (same
// shape fuel-logs.schemas.ts uses), and a per-aggregate MAX_TAKE mirrored from
// the service-side LIST_TAKE_MAX.
//
// THE FORWARD-COMPAT RULE (ADR-0038 c5): subjectType / reminderKind / state are
// stored as OPEN STRINGS in the Prisma model precisely so C3 could add the
// SERVICE_SCHEDULE subject and the SERVICE kind with no migration. The read
// filters honor that — they are bounded STRING filters (trim + length cap),
// NOT whitelisted enums. Hard-coding today's known values (VEHICLE / BLUEBOOK /
// …) into the query schema would couple this read path to the current set and
// silently 400 a future kind the moment a new source ships. So the filters
// accept any reasonable string and match it exactly; an unknown value simply
// returns zero rows (the correct "nothing matched" answer), never a 400.

// Whitelist of sortable columns. `sentAt` is the operator-meaningful "when did
// we actually send this reminder" instant and is the DEFAULT sort (most recent
// send first, ADR-0038 C4). `createdAt` is the ledger-row creation instant (it
// equals sentAt today, since rows are written at send-success, but it stays a
// distinct, always-non-null sort key the model already indexes —
// @@index([createdAt(sort: Desc)])). Allowing an arbitrary column would invite
// expensive sorts and accidental information disclosure on the recipient /
// occurrenceKey columns (`sortBy=recipient` would leak ordering signal about
// Tier-2 addresses — the same defense every list schema documents).
const SORTABLE_COLUMNS = ["sentAt", "createdAt"] as const;
export type NotificationLogSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type NotificationLogSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from notification-logs.service.ts on purpose:
// the service is the runtime authority (the schema can only validate what the
// client sent; it cannot speak for the database). Both constants must move
// together when one changes; the JSDoc on the service's LIST_TAKE_MAX flags the
// same coupling. Matches the 200 cap every other list surface uses.
const QUERY_MAX_TAKE = 200;

// Coerce a string-typed query param to a non-negative integer with bounds
// checking. Express's query parser hands us strings; without coercion the
// schema would reject every numeric param. Out-of-range values return 400 with
// a clear message rather than being silently clamped — identical shape to the
// customers / fuel-logs schema helper.
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

// A bounded exact-match string filter (subjectType / reminderKind / state). The
// open-string forward-compat rule above is why this is NOT a `z.enum`. Trim +
// length cap keep accidental query-string garbage out; an empty string (after
// trim) normalizes to `undefined` so `?subjectType=` means "no filter" rather
// than `where subjectType = ''` (which would match zero rows surprisingly).
function stringFilter(fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): string | undefined => {
      if (raw === undefined) return undefined;
      const trimmed = raw.trim();
      if (trimmed.length === 0) return undefined;
      if (trimmed.length > 64) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} is too long.` });
        return z.NEVER;
      }
      return trimmed;
    });
}

// Date-range filters on `sentAt`. `z.coerce.date()` accepts YYYY-MM-DD and ISO
// 8601 timestamps; an invalid value (e.g. "not-a-date") fails the parse with a
// 400. The bounds are applied inclusively at the service layer (gte startDate;
// lt startOfNextDay for a date-only endDate — see the service for the
// end-of-day inclusivity note). Same `DateFilter` shape as fuel-logs.schemas.ts.
const DateFilter = z.coerce
  .date({ error: () => "Must be a valid date (YYYY-MM-DD or ISO 8601)." })
  .optional();

// GET /api/v1/notification-logs query parameters (ADR-0038 C4 — read path).
// Filter / sort / pagination contract mirrors every other list endpoint so the
// web client reuses its paginator / sortable-header / filter-toolbar idioms.
export const ListNotificationLogsQuerySchema = z
  .object({
    // The subject domain — "VEHICLE" (compliance) / "SERVICE_SCHEDULE"
    // (maintenance) today; open string per the forward-compat rule above.
    subjectType: stringFilter("subjectType"),
    // Which document/dimension lapsed — "BLUEBOOK" / "INSURANCE" /
    // "ROUTE_PERMIT" / "SERVICE" today; open string.
    reminderKind: stringFilter("reminderKind"),
    // The threshold crossed — "expiring-soon" / "expired" / "due-soon" /
    // "overdue" today; open string.
    state: stringFilter("state"),
    startDate: DateFilter,
    endDate: DateFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g. `?subjecttype=VEHICLE`) surfaces as 400
  // rather than being silently ignored. Matches every other list contract.
  .strict();

export type ListNotificationLogsQuery = z.infer<typeof ListNotificationLogsQuerySchema>;
