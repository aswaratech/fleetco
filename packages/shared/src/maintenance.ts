// Service-schedule due/overdue classification (ADR-0037 c7), hosted in
// @fleetco/shared so BOTH apps consume ONE copy (ADR-0038 commitment 6 — the
// load-bearing drift guard). A ServiceSchedule (apps/api maintenance aggregate)
// is a recurring maintenance interval for a vehicle, measured in ONE of three
// dimensions:
//   - DISTANCE_KM   — against the vehicle's current odometer reading (km)
//   - ENGINE_HOURS  — against the vehicle's current hour-meter (integer tenths)
//   - CALENDAR_DAYS — against the wall clock
// "Next due" is DERIVED from the schedule's stored last-service anchor plus the
// interval; this module classifies that derived next-due against the vehicle's
// current reading (or the wall clock for calendar) into the SAME badge state
// the compliance section paints — an amber "Service due soon" / red "Service
// overdue" <Badge>. It is the maintenance sibling of `compliance.ts`.
//
// WHY THIS LIVES IN @fleetco/shared (ADR-0038 commitment 6): the reminder
// (apps/api notification scan, Program C) and the badge (apps/web Vehicle-detail
// page + the dashboard "services due" roll-up) MUST classify a schedule
// IDENTICALLY, or the operator gets a "Service overdue" email for a schedule the
// page shows as on-track (or vice-versa). The only way to guarantee that is one
// pure classifier both surfaces import — never a copy that can drift. This is the
// same anti-drift discipline that moved `complianceBadgeState` + `formatNepaliDate`
// here in C2. apps/web re-exports these symbols from its own `lib/maintenance.ts`
// so its existing `@/lib/maintenance` importers (the Vehicle detail page, the
// service-schedules detail + due pages, the dashboard, and maintenance.test.ts)
// are unchanged; apps/api imports them through the notification maintenance source.
//
// THE HONEST REUSE BOUNDARY (ADR-0037 c7), so a future reader sees exactly what
// is shared and what is specialized:
//   - The CALENDAR_DAYS case IS `complianceBadgeState`: next-due is a date
//     (lastServiceAt + intervalValue days) compared to `now` under the
//     load-bearing UTC-calendar-day rule. We REUSE the shipped helper — we do
//     NOT re-derive date math (the bug the pattern was built to avoid).
//   - The DISTANCE_KM / ENGINE_HOURS cases reuse the SHAPE, generalized from
//     "days remaining" to "units remaining": remaining = nextDue − current,
//     classified by the shared `thresholdState` core (strict `< 0` → overdue,
//     inclusive `≤ window` → due-soon, else ok). Same state machine, same
//     labels-paired-with-hue discipline, a different measuring stick.
//   - A null current reading (or a null anchor for the dimension) yields
//     `none` — no badge: an ENGINE_HOURS schedule on a vehicle whose
//     engineHoursCurrent is still null shows nothing yet ("tracks hours" ≠
//     "has a reading"), exactly as a null compliance expiry does.
// Both the date-specialized and meter-specialized paths sit on the ONE
// `thresholdState` primitive (`complianceBadgeState` itself does too), so the
// boundary semantics can never drift between the compliance and maintenance
// surfaces.
//
// No new design token: `none`/`overdue`/`due-soon`/`ok` feed the SAME shipped
// <Badge> (`error` = red "Service overdue", `warning` = amber "Service due
// soon"), so the design-token-drift test stays green (the ADR-0031 N3 posture).
//
// INACTIVE schedules are excluded from the surface (ADR-0037 c8f) at the FETCH
// layer — the Vehicle detail page requests `status=ACTIVE`, and the notification
// scan reads only ACTIVE schedules — so this classifier is status-agnostic and
// stays a pure function of (schedule, reading, now).

import { complianceBadgeState, MS_PER_DAY, thresholdState, utcStartOfDayMs } from "./compliance";

export type ServiceIntervalType = "DISTANCE_KM" | "ENGINE_HOURS" | "CALENDAR_DAYS";

/**
 * The badge state for one service schedule, the maintenance twin of
 * `ComplianceBadgeState`:
 * - `"none"`     — the schedule's next-due cannot be computed yet (a null
 *                  current reading or a null anchor for its dimension, or an
 *                  unparseable lastServiceAt): no badge.
 * - `"overdue"`  — next-due has passed: red "Service overdue" badge.
 * - `"due-soon"` — next-due is within the dimension's due-soon window
 *                  (inclusive): amber "Service due soon" badge.
 * - `"ok"`       — next-due is further out than the window: no badge.
 */
export type ServiceScheduleState = "none" | "overdue" | "due-soon" | "ok";

/**
 * The per-dimension "due soon" windows. ADR-0037 left these as owner-level
 * picks ("Revisit when … the PO sets the km / engine-hours / days thresholds,
 * the analog of ADR-0031's 30-day compliance window"); the PO chose build-now,
 * so these are PROVISIONAL defaults flagged in docs/tech-debt.md + the glossary
 * as the PO's to finalize (the GPS-retention-90-day precedent). Units:
 *   - distanceKm        — kilometers (a 500 km heads-up before a km service)
 *   - engineHoursTenths — integer tenths of an hour (250 = 25.0 h, matching
 *                         the schedule/anchor integer-minor-units storage)
 *   - calendarDays      — days (30, matching the compliance window so the two
 *                         calendar-based surfaces agree)
 */
export interface ServiceDueSoonWindows {
  distanceKm: number;
  engineHoursTenths: number;
  calendarDays: number;
}

export const DEFAULT_SERVICE_DUE_SOON_WINDOWS: ServiceDueSoonWindows = {
  distanceKm: 500,
  engineHoursTenths: 250,
  calendarDays: 30,
};

/**
 * The fields of a ServiceSchedule this module reads. A narrow interface (not
 * the full wire row) keeps the classifier decoupled and the unit tests terse;
 * the wider `ServiceScheduleRow` the Vehicle detail page fetches is
 * structurally assignable to it. Dates arrive as ISO strings over the JSON
 * wire; meter anchors are integers (km / tenths-of-an-hour) or null.
 */
export interface ServiceScheduleAnchor {
  intervalType: ServiceIntervalType;
  intervalValue: number;
  lastServiceAt: string;
  lastServiceOdometerKm: number | null;
  lastServiceEngineHours: number | null;
}

/**
 * The vehicle's current meter readings the meter cases measure against.
 * `odometerCurrentKm` is `Int @default(0)` on the API (never null in practice)
 * but typed nullable here for defensive symmetry with the hour-meter, which is
 * genuinely null until an SMR is keyed in.
 */
export interface VehicleMeterReading {
  odometerCurrentKm: number | null;
  engineHoursCurrent: number | null;
}

// none/expired/expiring-soon/ok (compliance) → none/overdue/due-soon/ok
// (maintenance). The calendar case routes through the shipped compliance
// helper, then relabels — the state machine is identical, only the words
// "expired/expiring-soon" become "overdue/due-soon".
const COMPLIANCE_TO_SERVICE = {
  none: "none",
  expired: "overdue",
  "expiring-soon": "due-soon",
  ok: "ok",
} as const;

// past/within/beyond (the shared threshold core) → overdue/due-soon/ok. The
// meter cases use this directly: there is no date, only a units-remaining
// integer.
const THRESHOLD_TO_SERVICE = {
  past: "overdue",
  within: "due-soon",
  beyond: "ok",
} as const;

// The CALENDAR_DAYS next-due instant, in epoch-ms of a whole UTC day, or null
// when lastServiceAt is unparseable (guarded so `new Date(NaN).toISOString()`
// — which throws — is never reached). nextDueDate = lastServiceAt + interval
// days, both truncated to the UTC calendar day so the result is a clean UTC
// midnight that complianceBadgeState compares deterministically.
function calendarNextDueMs(schedule: ServiceScheduleAnchor): number | null {
  const last = new Date(schedule.lastServiceAt);
  if (Number.isNaN(last.getTime())) return null;
  return utcStartOfDayMs(last) + schedule.intervalValue * MS_PER_DAY;
}

// Shared meter classification (DISTANCE_KM / ENGINE_HOURS). A null current
// reading or a null anchor → none (cannot derive next-due yet). Otherwise
// remaining = (anchor + interval) − current, classified by the shared core.
function meterState(
  current: number | null,
  anchor: number | null,
  intervalValue: number,
  window: number,
): ServiceScheduleState {
  if (current === null || anchor === null) return "none";
  const remaining = anchor + intervalValue - current;
  return THRESHOLD_TO_SERVICE[thresholdState(remaining, window)];
}

/**
 * Classify a service schedule against the vehicle's current reading (meter
 * dimensions) or the wall clock (calendar dimension) into a badge state.
 *
 * @param schedule the schedule's interval + last-service anchor
 * @param vehicle  the vehicle's current meter readings
 * @param now      the reference instant (callers pass `new Date()`); the
 *                 calendar case compares by UTC calendar day, not by instant
 * @param windows  the per-dimension due-soon windows (default
 *                 DEFAULT_SERVICE_DUE_SOON_WINDOWS — the provisional picks)
 */
export function serviceScheduleState(
  schedule: ServiceScheduleAnchor,
  vehicle: VehicleMeterReading,
  now: Date,
  windows: ServiceDueSoonWindows = DEFAULT_SERVICE_DUE_SOON_WINDOWS,
): ServiceScheduleState {
  switch (schedule.intervalType) {
    case "CALENDAR_DAYS": {
      const nextDueMs = calendarNextDueMs(schedule);
      if (nextDueMs === null) return "none";
      // The calendar case IS complianceBadgeState — reuse the shipped helper's
      // UTC-calendar-day date math, then relabel expired/expiring-soon →
      // overdue/due-soon.
      const compliance = complianceBadgeState(
        new Date(nextDueMs).toISOString(),
        now,
        windows.calendarDays,
      );
      return COMPLIANCE_TO_SERVICE[compliance];
    }
    case "DISTANCE_KM":
      return meterState(
        vehicle.odometerCurrentKm,
        schedule.lastServiceOdometerKm,
        schedule.intervalValue,
        windows.distanceKm,
      );
    case "ENGINE_HOURS":
      return meterState(
        vehicle.engineHoursCurrent,
        schedule.lastServiceEngineHours,
        schedule.intervalValue,
        windows.engineHoursTenths,
      );
  }
}

/**
 * The schedule's derived "next due" value, for rendering beside the badge.
 * Exactly one of the three is non-null, keyed by `intervalType`:
 *   - CALENDAR_DAYS → `dateIso` (an ISO string for <NepaliDate>)
 *   - DISTANCE_KM   → `km` (integer km for formatKm)
 *   - ENGINE_HOURS  → `engineHoursTenths` (integer tenths for formatHours)
 * The active value is null when its anchor is missing (or lastServiceAt is
 * unparseable) — the same inputs that make `serviceScheduleState` return
 * `none` — so the page renders an em-dash and no badge together. "Next due" is
 * derived here, never stored (the same denormalization-free read the ADR's
 * "next due is derived, not stored" mandates).
 */
export function nextDueForSchedule(schedule: ServiceScheduleAnchor): {
  dateIso: string | null;
  km: number | null;
  engineHoursTenths: number | null;
} {
  switch (schedule.intervalType) {
    case "CALENDAR_DAYS": {
      const ms = calendarNextDueMs(schedule);
      return {
        dateIso: ms === null ? null : new Date(ms).toISOString(),
        km: null,
        engineHoursTenths: null,
      };
    }
    case "DISTANCE_KM":
      return {
        dateIso: null,
        km:
          schedule.lastServiceOdometerKm === null
            ? null
            : schedule.lastServiceOdometerKm + schedule.intervalValue,
        engineHoursTenths: null,
      };
    case "ENGINE_HOURS":
      return {
        dateIso: null,
        km: null,
        engineHoursTenths:
          schedule.lastServiceEngineHours === null
            ? null
            : schedule.lastServiceEngineHours + schedule.intervalValue,
      };
  }
}

// Worst-of precedence across several service-schedule states (ADR-0037 c7) — the
// rotation of `worstComplianceState`'s COMPLIANCE_RANK. Higher rank = more
// urgent = "worse": `overdue` outranks `due-soon` outranks `ok` outranks
// `none`. This is the single source of truth for "which service state is
// worse"; the due-list's per-vehicle roll-up badge reaches it through
// `worstServiceState` rather than re-declaring the ordering, exactly as the
// vehicles-list / dashboard reach compliance through `worstComplianceState`.
const SERVICE_RANK: Record<ServiceScheduleState, number> = {
  none: 0,
  ok: 1,
  "due-soon": 2,
  overdue: 3,
};

/**
 * One (schedule, vehicle-reading) pair — the raw input `serviceScheduleState`
 * classifies. `worstServiceState` takes an array of these because, unlike a
 * vehicle's three compliance documents (which share one date axis), schedules
 * are each measured against their OWN vehicle's reading, so the worst-of helper
 * must carry the reading alongside every schedule (a fleet-wide roll-up spans
 * many vehicles). For a single-vehicle roll-up the same `vehicle` is repeated.
 */
export interface ScheduleWithReading {
  schedule: ServiceScheduleAnchor;
  vehicle: VehicleMeterReading;
}

/**
 * The worst (most urgent) service state across several schedules — the
 * array-shaped sibling of `serviceScheduleState`, and the maintenance rotation
 * of `worstComplianceState`.
 *
 * It classifies EACH pair with the shipped `serviceScheduleState` (the state
 * machine, the per-dimension windows, and the UTC-calendar-day rule all live
 * there and are NEVER re-derived here — `windows` is forwarded verbatim) and
 * returns the worst result by the precedence `overdue` > `due-soon` > `ok` >
 * `none`. An empty list — or one whose every schedule classifies to `none`
 * (a null reading / anchor) — is `none` (the reduce floor), exactly as an empty
 * compliance list is `none`.
 *
 * The due-list groups the fleet's due/overdue schedules by vehicle and paints
 * one worst-of `<Badge>` per vehicle from this helper, the rotation of the
 * vehicles-list per-vehicle worst-compliance badge.
 *
 * @param items   the (schedule, vehicle-reading) pairs to roll up
 * @param now     the reference instant (callers pass `new Date()`); the calendar
 *                dimension compares by UTC calendar day, not by instant
 * @param windows the per-dimension due-soon windows (default
 *                DEFAULT_SERVICE_DUE_SOON_WINDOWS), forwarded to
 *                `serviceScheduleState` for every pair
 */
export function worstServiceState(
  items: readonly ScheduleWithReading[],
  now: Date,
  windows: ServiceDueSoonWindows = DEFAULT_SERVICE_DUE_SOON_WINDOWS,
): ServiceScheduleState {
  return items.reduce<ServiceScheduleState>((worst, item) => {
    const state = serviceScheduleState(item.schedule, item.vehicle, now, windows);
    return SERVICE_RANK[state] > SERVICE_RANK[worst] ? state : worst;
  }, "none");
}
