import { describe, expect, test } from "vitest";

import { notificationDedupKey } from "../src/modules/notifications/compliance-source";
import {
  collectServiceMaintenanceReminders,
  type MaintenanceSchedule,
} from "../src/modules/notifications/maintenance-source";

// Pure unit tests for the maintenance reminder SOURCE (ADR-0038 C3 / c6), the
// symmetric sibling of notification.compliance-source.test.ts. No DB / network /
// clock: `now` is explicit. The classification delegates to the SHARED
// serviceScheduleState (ADR-0038 c6), so these tests pin the source's behavior —
// which schedules become items, the dedup tuple (subjectType / reminderKind /
// state / occurrenceKey), and the dueLabel rendering per dimension — not the
// boundary math (the shared maintenance.test.ts owns that).

// now = 2026-05-25 (UTC), the same fixed instant as the compliance-source test.
const NOW = new Date("2026-05-25T12:00:00.000Z");

// A DISTANCE_KM schedule whose nextDue is 12000 + 3000 = 15000 km. The vehicle's
// odometerCurrentKm in each test sets the state:
//   15001 → overdue (remaining −1); 14600 → due-soon (remaining 400, ≤ 500
//   window); 14000 → ok (remaining 1000).
function distanceSchedule(overrides: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule {
  return {
    id: "s1",
    name: "10,000 km service",
    registrationNumber: "BA 2 KHA 1234",
    intervalType: "DISTANCE_KM",
    intervalValue: 3000,
    lastServiceAt: "2026-01-01T00:00:00.000Z",
    lastServiceOdometerKm: 12000,
    lastServiceEngineHours: null,
    odometerCurrentKm: 14000,
    engineHoursCurrent: null,
    ...overrides,
  };
}

describe("collectServiceMaintenanceReminders — DISTANCE_KM (ADR-0038 C3)", () => {
  test("an overdue schedule produces one overdue item keyed by the next-due km", () => {
    const items = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: 15001 })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      subjectType: "SERVICE_SCHEDULE",
      subjectId: "s1",
      subjectLabel: "BA 2 KHA 1234",
      reminderKind: "SERVICE",
      kindLabel: "10,000 km service",
      state: "overdue",
      occurrenceKey: "15000", // raw integer string — deterministic dedup key
      dueLabel: "15,000 km", // grouped display value
    });
  });

  test("a due-soon schedule produces one due-soon item", () => {
    const items = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: 14600 })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "due-soon", occurrenceKey: "15000" });
  });

  test("an ok (far-from-due) schedule produces no item", () => {
    const items = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: 14000 })],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  test("a null odometer reading produces no item (cannot derive next-due yet)", () => {
    const items = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: null, lastServiceOdometerKm: 12000 })],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  test("a null anchor produces no item", () => {
    const items = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: 15001, lastServiceOdometerKm: null })],
      NOW,
    );
    expect(items).toHaveLength(0);
  });
});

describe("collectServiceMaintenanceReminders — ENGINE_HOURS (ADR-0038 C3)", () => {
  // nextDue tenths = 10000 + 2500 = 12500 (= 1250.0 h). current 12501 → overdue.
  function hoursSchedule(overrides: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule {
    return {
      id: "s2",
      name: "250-hour service",
      registrationNumber: "BA 9 PA 1",
      intervalType: "ENGINE_HOURS",
      intervalValue: 2500,
      lastServiceAt: "2026-01-01T00:00:00.000Z",
      lastServiceOdometerKm: null,
      lastServiceEngineHours: 10000,
      odometerCurrentKm: null,
      engineHoursCurrent: 12501,
      ...overrides,
    };
  }

  test("an overdue hours schedule keys by the next-due tenths and renders hours", () => {
    const items = collectServiceMaintenanceReminders([hoursSchedule()], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      state: "overdue",
      occurrenceKey: "12500", // raw tenths string
      dueLabel: "1250.0 h",
      reminderKind: "SERVICE",
    });
  });

  test("a null hour-meter reading produces no item", () => {
    const items = collectServiceMaintenanceReminders(
      [hoursSchedule({ engineHoursCurrent: null })],
      NOW,
    );
    expect(items).toHaveLength(0);
  });
});

describe("collectServiceMaintenanceReminders — CALENDAR_DAYS (ADR-0038 C3)", () => {
  function calendarSchedule(overrides: Partial<MaintenanceSchedule> = {}): MaintenanceSchedule {
    return {
      id: "s3",
      name: "Annual inspection",
      registrationNumber: "BA 1 CHA 99",
      intervalType: "CALENDAR_DAYS",
      intervalValue: 30,
      lastServiceAt: "2026-03-01T00:00:00.000Z", // + 30d = 2026-03-31 (overdue vs NOW)
      lastServiceOdometerKm: null,
      lastServiceEngineHours: null,
      odometerCurrentKm: null,
      engineHoursCurrent: null,
      ...overrides,
    };
  }

  test("an overdue calendar schedule keys by the next-due date ISO and renders BS", () => {
    const items = collectServiceMaintenanceReminders([calendarSchedule()], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      state: "overdue",
      occurrenceKey: "2026-03-31T00:00:00.000Z",
    });
    // dueLabel is a Bikram-Sambat rendering (never the em-dash, never the raw ISO).
    expect(items[0].dueLabel).not.toBe("—");
    expect(items[0].dueLabel).not.toBe("2026-03-31T00:00:00.000Z");
  });

  test("a due-soon calendar schedule (next-due within the 30-day window)", () => {
    // lastServiceAt + 30d = 2026-06-10, 16 days after NOW → due-soon.
    const items = collectServiceMaintenanceReminders(
      [calendarSchedule({ lastServiceAt: "2026-05-11T00:00:00.000Z" })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      state: "due-soon",
      occurrenceKey: "2026-06-10T00:00:00.000Z",
    });
  });
});

describe("collectServiceMaintenanceReminders — multiple + re-arm (ADR-0038 C3)", () => {
  test("scans multiple schedules independently", () => {
    const items = collectServiceMaintenanceReminders(
      [
        distanceSchedule({ id: "s1", odometerCurrentKm: 15001 }), // overdue
        distanceSchedule({ id: "s2", odometerCurrentKm: 14000 }), // ok
      ],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].subjectId).toBe("s1");
  });

  test("a completed service that advances the anchor yields a NEW occurrenceKey (re-arms)", () => {
    // Before service: anchor 12000, current 15001 → next-due 15000, overdue.
    const before = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: 15001, lastServiceOdometerKm: 12000 })],
      NOW,
    );
    // After service: anchor advanced to 15000, current 18001 → next-due 18000.
    const after = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: 18001, lastServiceOdometerKm: 15000 })],
      NOW,
    );
    expect(before[0].occurrenceKey).toBe("15000");
    expect(after[0].occurrenceKey).toBe("18000");
    // Distinct dedup keys → the next lapse is a genuinely new reminder.
    expect(notificationDedupKey(before[0])).not.toBe(notificationDedupKey(after[0]));
  });

  test("the dedup key carries the SERVICE_SCHEDULE subjectType and SERVICE kind", () => {
    const [item] = collectServiceMaintenanceReminders(
      [distanceSchedule({ odometerCurrentKm: 15001 })],
      NOW,
    );
    // Separator-agnostic: the item's dedup key equals the key built from the
    // expected tuple, proving the source mapped every field correctly without
    // pinning the join character.
    expect(notificationDedupKey(item)).toBe(
      notificationDedupKey({
        subjectType: "SERVICE_SCHEDULE",
        subjectId: "s1",
        reminderKind: "SERVICE",
        state: "overdue",
        occurrenceKey: "15000",
      }),
    );
  });
});
