import {
  formatNepaliDate,
  nextDueForSchedule,
  serviceScheduleState,
  type ServiceDueSoonWindows,
  type ServiceIntervalType,
  type ServiceScheduleAnchor,
  type VehicleMeterReading,
} from "@fleetco/shared";

import { type MaintenanceReminderState, type ReminderItem } from "./compliance-source";

// The MAINTENANCE reminder source (ADR-0038 commitment 6 / C3), the symmetric
// sibling of compliance-source.ts. It classifies each ACTIVE service schedule's
// derived next-due against the vehicle's current meter reading (or the wall
// clock for a calendar schedule) into the remind-worthy items the daily scan
// diffs against the NotificationLog and emails. The classification uses the
// SHARED `serviceScheduleState` from @fleetco/shared — the SAME pure helper the
// web Vehicle-detail "Service due"/dashboard badges use — so the reminder and
// the badge can never disagree (the load-bearing drift guard, ADR-0038 c6, the
// reason C3 step 1 moved the classifier to @fleetco/shared). This module is pure
// (no Prisma, no env, no clock): the service reads the schedules + their
// vehicles' readings and passes them in, so the classification is unit-testable
// in isolation, exactly as the compliance source is.
//
// SCOPE NOTE: the scan reads only ACTIVE schedules (ADR-0037 c8f excludes
// INACTIVE from the surface, at the fetch layer — the scan's Prisma WHERE), so a
// schedule the operator has paused does not remind. A schedule on a RETIRED/SOLD
// vehicle still reminds if it is ACTIVE — the same v1 posture as the compliance
// source (remind on all, filter later if noisy). Both are scope filters, not
// classifier changes, so neither breaches the c6 drift guarantee.

/** The notification subject domain for a service-schedule reminder (ADR-0038 c5). */
export const SUBJECT_TYPE_SERVICE_SCHEDULE = "SERVICE_SCHEDULE";

/**
 * The reminder kind for a service schedule. Unlike a vehicle (which has THREE
 * compliance documents, distinguished by reminderKind), a service schedule IS
 * its own subject — the schedule id is the subjectId — so a single constant kind
 * is sufficient. Stored verbatim in NotificationLog.reminderKind (a String
 * column, so this needs no migration — the C3 migration-free guarantee).
 */
export const SERVICE_REMINDER_KIND = "SERVICE";

/**
 * The minimal service-schedule shape the source needs: its id (subjectId), the
 * vehicle's registration (the digest's subject label), the schedule name (the
 * digest's kind label), the anchor fields `serviceScheduleState` /
 * `nextDueForSchedule` read, and the vehicle's current meter readings the meter
 * dimensions measure against. The service maps Prisma's `ServiceSchedule` + its
 * related `Vehicle` onto this flat shape (lastServiceAt as an ISO string, like
 * the compliance source converts the expiry Dates).
 */
export interface MaintenanceSchedule {
  id: string;
  name: string;
  registrationNumber: string;
  intervalType: ServiceIntervalType;
  intervalValue: number;
  lastServiceAt: string;
  lastServiceOdometerKm: number | null;
  lastServiceEngineHours: number | null;
  odometerCurrentKm: number | null;
  engineHoursCurrent: number | null;
}

// Grouped thousands for the km dueLabel (e.g. "15,000 km"), mirroring the web
// units.ts KM formatter for operator familiarity. This is DISPLAY only — the
// dedup occurrenceKey uses the raw integer string, so the (deterministic) dedup
// key never depends on ICU locale formatting.
const KM_FORMATTER = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * The dedup occurrenceKey (raw, deterministic) AND the human-readable dueLabel
 * (display) for a schedule's derived next-due, by dimension. Returns null only
 * defensively — a schedule that reached a remind-worthy state always has a
 * non-null next-due for its dimension (a null anchor classifies to `none`), so
 * null here is unreachable in practice but keeps the function total.
 */
function occurrenceForNextDue(
  intervalType: ServiceIntervalType,
  nextDue: { dateIso: string | null; km: number | null; engineHoursTenths: number | null },
): { key: string; label: string } | null {
  switch (intervalType) {
    case "CALENDAR_DAYS":
      // Same BS rendering the compliance digest uses for a date occurrenceKey.
      return nextDue.dateIso === null
        ? null
        : { key: nextDue.dateIso, label: formatNepaliDate(nextDue.dateIso) };
    case "DISTANCE_KM":
      return nextDue.km === null
        ? null
        : { key: String(nextDue.km), label: `${KM_FORMATTER.format(nextDue.km)} km` };
    case "ENGINE_HOURS":
      // Integer tenths → "250.0 h", mirroring the web units.ts hours formatter.
      return nextDue.engineHoursTenths === null
        ? null
        : {
            key: String(nextDue.engineHoursTenths),
            label: `${(nextDue.engineHoursTenths / 10).toFixed(1)} h`,
          };
  }
}

/**
 * Classify every ACTIVE service schedule into the remind-worthy items
 * (`overdue` / `due-soon`). `ok` and `none` produce no item. Pure — `now` and
 * `windows` are explicit so the boundary is deterministically testable, and the
 * classification is the shared `serviceScheduleState` so it matches the badge
 * exactly (ADR-0038 c6).
 *
 * The occurrenceKey is the schedule's DERIVED next-due value (the date ISO, or
 * the integer km / engine-hours-tenths as a string). When a completed service
 * advances the schedule's anchor (the ADR-0037 B4 $transaction), the next-due
 * moves and the occurrenceKey changes, so the next lapse re-arms — the same
 * "renewal re-arms" semantics the compliance source gets from a new expiry
 * (ADR-0038 c5).
 *
 * @param schedules  the ACTIVE schedules + their vehicles' current readings
 * @param now        the reference instant (the scan passes `new Date()`)
 * @param windows    the per-dimension due-soon windows (default the shared
 *                   DEFAULT_SERVICE_DUE_SOON_WINDOWS, forwarded verbatim to the
 *                   shared classifier — never re-derived here)
 */
export function collectServiceMaintenanceReminders(
  schedules: readonly MaintenanceSchedule[],
  now: Date,
  windows?: ServiceDueSoonWindows,
): ReminderItem[] {
  const items: ReminderItem[] = [];
  for (const schedule of schedules) {
    const anchor: ServiceScheduleAnchor = {
      intervalType: schedule.intervalType,
      intervalValue: schedule.intervalValue,
      lastServiceAt: schedule.lastServiceAt,
      lastServiceOdometerKm: schedule.lastServiceOdometerKm,
      lastServiceEngineHours: schedule.lastServiceEngineHours,
    };
    const reading: VehicleMeterReading = {
      odometerCurrentKm: schedule.odometerCurrentKm,
      engineHoursCurrent: schedule.engineHoursCurrent,
    };

    const state = serviceScheduleState(anchor, reading, now, windows);
    if (state !== "overdue" && state !== "due-soon") continue;

    const occurrence = occurrenceForNextDue(schedule.intervalType, nextDueForSchedule(anchor));
    // Defensive: a remind-worthy state implies a derivable next-due, so this is
    // unreachable in practice — but skip rather than push an item with no key.
    if (occurrence === null) continue;

    const reminderState: MaintenanceReminderState = state;
    items.push({
      subjectType: SUBJECT_TYPE_SERVICE_SCHEDULE,
      subjectId: schedule.id,
      subjectLabel: schedule.registrationNumber,
      reminderKind: SERVICE_REMINDER_KIND,
      kindLabel: schedule.name,
      state: reminderState,
      occurrenceKey: occurrence.key,
      dueLabel: occurrence.label,
    });
  }
  return items;
}
