import { z } from "zod";

// Zod schemas for the Reports v1 slice (iter 23). The reports module
// is a read-only aggregation over two already-landed write paths
// (Fuel logs iter 19/20 and Expense logs iter 21/22); it owns no
// model and no write surface. The only schema this module exposes is
// the query schema for `GET /api/v1/reports/per-vehicle-cost`.
//
// Mirrors the convention every other vertical-slice schema file
// uses:
//
//   - `.strict()` so a typo'd query key (`?vehicelId=...`) surfaces
//     as HTTP 400 rather than being silently ignored — the same
//     defense Fuel logs / Expense logs / Jobs / Trips apply at the
//     read-path query.
//
//   - Coerced types: `from` / `to` are accepted as YYYY-MM-DD strings
//     and converted to Date objects the service can use directly.
//     ISO 8601 timestamps are NOT accepted on this surface — unlike
//     the list endpoints' `startDate` / `endDate` which accept ISO
//     8601 too, the cost report's date range is operator-facing on a
//     calendar-month picker UI (apps/web/src/app/reports/
//     per-vehicle-cost/) and the wire contract picks the strictest
//     form that lines up with the picker. A future API consumer that
//     wants ISO 8601 (e.g., a scheduled-report job that runs every
//     hour and wants sub-day windows) can widen the schema; the iter-
//     23 ticket scopes this report to calendar dates.
//
//   - Cross-field rule (`from <= to`) at the schema layer — the
//     service trusts the validated query, so the inversion check
//     belongs here, not at the service. Bad inversion returns HTTP
//     400 with a clear `from` / `to`-named message. Same pattern as
//     the Jobs iter-18 date-pair refines.
//
//   - `vehicleId` is OPTIONAL and uses the same cuid shape every
//     other read-path query uses, so an empty `?vehicleId=` is
//     normalized to undefined (no filter) rather than asking Prisma
//     for `where vehicleId = ''` which would match zero rows. When
//     present, it narrows the report to a single vehicle's bucket
//     plus the company-level bucket (which is independent of the
//     vehicle filter — see ReportsService.getPerVehicleCost).

// YYYY-MM-DD pattern, matched at the regex level so an ISO 8601
// timestamp (which `z.coerce.date()` would otherwise accept) fails
// the parse. The cost report is calendar-day-bucketed; a sub-day
// timestamp on the wire would be silently truncated to midnight UTC
// and could mislead the operator about what "from" really meant. A
// hard reject is safer than a silent truncation.
const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

// Parse a YYYY-MM-DD string into a Date at UTC midnight. The service
// treats `from` as inclusive-from-midnight and `to` as
// inclusive-through-end-of-day; this helper returns the midnight
// boundary, and the service shifts `to` by one day minus one
// millisecond when it builds the Prisma WHERE clause. Centralising
// the midnight construction here means tests, the service, and the
// web page all agree on the same wire interpretation.
//
// Note that we deliberately use `Date.UTC(...)` rather than
// `new Date("YYYY-MM-DD")` because the latter is interpreted as UTC
// midnight by spec but several reasonable test environments
// (legacy Node, browsers under certain locales) have been observed
// to parse it as local-midnight; UTC math is the safe form.
function dateAtUtcMidnight(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

const DateOnly = z
  .string({ error: () => "Must be a date in YYYY-MM-DD format." })
  .regex(YYYY_MM_DD, "Must be a date in YYYY-MM-DD format.")
  .transform((raw, ctx): Date => {
    const date = dateAtUtcMidnight(raw);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Must be a date in YYYY-MM-DD format." });
      return z.NEVER;
    }
    return date;
  });

// cuid shape for the optional `vehicleId` filter. Same shape as the
// read-path filters on Fuel logs / Expense logs; empty string after
// `optional()` is normalised to `undefined` so the service omits
// the filter rather than asking Prisma for `where vehicleId = ''`.
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

export const ReportsQuerySchema = z
  .object({
    from: DateOnly,
    to: DateOnly,
    vehicleId: CuidFilter,
  })
  .strict()
  .refine(
    (data) => {
      // Defensive: if either per-field transform failed (e.g., the
      // YYYY-MM-DD regex rejected the input), Zod still calls this
      // refine with a `NEVER` sentinel in place of the Date. Skip
      // the cross-field check in that case so the per-field error
      // is the one surfaced. Without this guard a refactor that
      // tightened either DateOnly would cause refine to crash with
      // a TypeError that escapes the ZodValidationPipe.
      if (!(data.from instanceof Date) || !(data.to instanceof Date)) return true;
      return data.from.getTime() <= data.to.getTime();
    },
    {
      // The cross-field check after the per-field coerce — `from` and
      // `to` are already Date objects here, so the comparison is a
      // simple millisecond ordering. The error path names `to` so the
      // web form can highlight the right input.
      message: "`from` must be on or before `to`.",
      path: ["to"],
    },
  );

export type ReportsQuery = z.infer<typeof ReportsQuerySchema>;
