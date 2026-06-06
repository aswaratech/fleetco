// Vehicle-compliance expiry classification for the web (ADR-0031 commitment 5
// / §E). FleetCo stores compliance-document expiry dates (bluebook, insurance,
// route permit) as ISO/UTC on the Vehicle aggregate; this pure helper
// classifies one such date against "now" into the badge state the Vehicle
// detail page paints as an amber "Expiring soon" / red "Expired" <Badge>. It
// is the classification sibling of `nepali-date.ts`'s formatter — same module
// family (date display + date status), kept in its own file so the BS
// formatter stays purely about rendering.
//
// THE UTC-CALENDAR-DAY RULE (ADR-0031 commitment 5 — load-bearing): the
// comparison truncates BOTH `expiry` and `now` to their UTC calendar day (via
// the getUTC* accessors — the SAME discipline `formatNepaliDate` uses to pick
// the day it renders), so the 30-day boundary is a function of calendar days
// alone and is deterministic regardless of the server's timezone. Two instants
// on the same UTC day count as the same day here, even if one is instant-wise
// "before" the other. Pinned by a timezone-independent test in
// `test/compliance.test.ts`.
//
// NOTE on `Date.UTC`: unlike the formatter — which deliberately AVOIDS
// `Date.UTC` because `nepali-date-converter` reads a Date through server-LOCAL
// getters — this helper USES `Date.UTC(...)` to turn each date's UTC calendar
// day into a comparable integer. There is no library reading local getters
// here; both operands go through the identical truncation, so the comparison
// is purely calendar-day arithmetic and timezone-independent by construction.
// (Reconciling the two: both modules operate on the UTC calendar day; they
// differ only in what they then DO with it — render via a local-getter library
// vs. compare as integers.)

/**
 * The badge state for one compliance-document expiry date:
 * - `"none"`          — no date (null / undefined / unparseable): render the
 *                       date alone, no badge.
 * - `"expired"`       — the expiry's UTC day is before today's UTC day: red
 *                       "Expired" badge.
 * - `"expiring-soon"` — the expiry is today (day 0) through day `windowDays`
 *                       inclusive: amber "Expiring soon" badge.
 * - `"ok"`            — the expiry is further out than `windowDays`: no badge.
 */
export type ComplianceBadgeState = "none" | "expired" | "expiring-soon" | "ok";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Truncate a Date to the UTC midnight of its calendar day, as an epoch-ms
// integer. Reads the UTC components (the same getUTC* accessors the BS
// formatter uses to choose the rendered day), so the result is independent of
// the server's local timezone.
function utcStartOfDayMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Classify a compliance-document expiry date into a badge state.
 *
 * Default 30-day "expiring soon" window (ADR-0031 commitment 5 — the
 * PO-ratified threshold). Boundaries, by UTC calendar day relative to `now`:
 *   - yesterday or earlier              → "expired"
 *   - today (day 0) … day `windowDays`  → "expiring-soon"  (both ends inclusive)
 *   - day `windowDays + 1` or later     → "ok"
 *
 * @param expiryIso  the stored ISO/UTC expiry date; null / undefined /
 *                   unparseable → "none"
 * @param now        the reference instant (callers pass `new Date()`); compared
 *                   by UTC calendar day, not by instant
 * @param windowDays the expiring-soon window in days (default 30)
 */
export function complianceBadgeState(
  expiryIso: string | null | undefined,
  now: Date,
  windowDays = 30,
): ComplianceBadgeState {
  if (expiryIso === null || expiryIso === undefined) return "none";
  const expiry = new Date(expiryIso);
  if (Number.isNaN(expiry.getTime())) return "none";

  const expiryDay = utcStartOfDayMs(expiry);
  const today = utcStartOfDayMs(now);
  if (expiryDay < today) return "expired";
  if (expiryDay <= today + windowDays * MS_PER_DAY) return "expiring-soon";
  return "ok";
}

// Worst-of precedence across several compliance states: a roll-up's state is
// the MOST URGENT of its inputs. Higher rank = more urgent = "worse" —
// `expired` outranks `expiring-soon` outranks `ok` outranks `none`. This is the
// single source of truth for "which compliance state is worse"; both the
// vehicles-list roll-up column (vehicles/page.tsx) and the Home dashboard's
// per-vehicle roll-up (lib/dashboard.ts's `vehicleComplianceState`) reach it
// through `worstComplianceState` rather than re-declaring the ordering.
const COMPLIANCE_RANK: Record<ComplianceBadgeState, number> = {
  none: 0,
  ok: 1,
  "expiring-soon": 2,
  expired: 3,
};

/**
 * The worst (most urgent) compliance state across several expiry dates.
 *
 * The array-shaped sibling of `complianceBadgeState`: it classifies EACH expiry
 * with that shipped helper and returns the worst result by the precedence
 * `expired` > `expiring-soon` > `ok` > `none`. The 30-day window and the
 * UTC-calendar-day rule live in `complianceBadgeState` (ADR-0031 commitment 5)
 * and are never re-derived here — `windowDays` is forwarded to it verbatim for
 * every expiry. An empty list, or one of all null / undefined / unparseable
 * dates, is `none` (the reduce floor).
 *
 * The vehicles-list compliance column passes a vehicle's three document
 * expiries (bluebook / insurance / route permit) and paints the single worst
 * state as one badge (ADR-0031 §E / "Revisit when"). `lib/dashboard.ts`'s
 * `vehicleComplianceState` is a vehicle-object-shaped wrapper over this same
 * primitive.
 *
 * @param expiries   the stored ISO/UTC expiry dates; each null / undefined /
 *                   unparseable contributes `none`
 * @param now        the reference instant (callers pass `new Date()`); compared
 *                   by UTC calendar day, not by instant
 * @param windowDays the expiring-soon window in days (default 30), forwarded to
 *                   `complianceBadgeState` for every expiry
 */
export function worstComplianceState(
  expiries: readonly (string | null | undefined)[],
  now: Date,
  windowDays = 30,
): ComplianceBadgeState {
  return expiries.reduce<ComplianceBadgeState>((worst, expiry) => {
    const state = complianceBadgeState(expiry, now, windowDays);
    return COMPLIANCE_RANK[state] > COMPLIANCE_RANK[worst] ? state : worst;
  }, "none");
}
