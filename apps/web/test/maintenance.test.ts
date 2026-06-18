import { afterEach, describe, expect, test } from "vitest";

import { complianceBadgeState, MS_PER_DAY } from "../src/lib/compliance";
import {
  DEFAULT_SERVICE_DUE_SOON_WINDOWS,
  nextDueForSchedule,
  serviceScheduleState,
  type ServiceDueSoonWindows,
  type ServiceScheduleAnchor,
  type VehicleMeterReading,
} from "../src/lib/maintenance";

/**
 * Pins the pure service-schedule due/overdue classifier (ADR-0037 c7), the
 * maintenance sibling of `complianceBadgeState`. Coverage mirrors
 * compliance.test.ts: the four states across all three interval dimensions,
 * the exact due-soon window boundaries, the null-reading / null-anchor → none
 * case, the calendar case's UTC-calendar-day TZ-independence, and the
 * `nextDueForSchedule` derivations.
 *
 * The load-bearing reuse boundary (ADR-0037 c7): the CALENDAR_DAYS case IS
 * `complianceBadgeState` relabeled, and the meter cases share the same
 * `thresholdState` core — so the boundary semantics (strict `< 0` overdue,
 * inclusive `≤ window` due-soon) are pinned identically to the compliance
 * surface and cannot drift.
 */

// Same fixed "now" as compliance.test.ts: a non-midnight time-of-day so the
// calendar truncation is exercised. Its UTC calendar day is 2026-06-15.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

const READING_BOTH: VehicleMeterReading = { odometerCurrentKm: 0, engineHoursCurrent: 0 };

function kmSchedule(
  lastServiceOdometerKm: number | null,
  intervalValue = 5000,
): ServiceScheduleAnchor {
  return {
    intervalType: "DISTANCE_KM",
    intervalValue,
    lastServiceAt: NOW_ISO,
    lastServiceOdometerKm,
    lastServiceEngineHours: null,
  };
}

function hoursSchedule(
  lastServiceEngineHours: number | null,
  intervalValue = 2500,
): ServiceScheduleAnchor {
  return {
    intervalType: "ENGINE_HOURS",
    intervalValue,
    lastServiceAt: NOW_ISO,
    lastServiceOdometerKm: null,
    lastServiceEngineHours,
  };
}

// A CALENDAR schedule whose derived next-due lands `daysUntilDue` whole UTC
// days from NOW's calendar day. nextDue = utcDay(lastServiceAt) + intervalValue,
// so we back-solve lastServiceAt = NOW_day + daysUntilDue − intervalValue.
function calendarSchedule(daysUntilDue: number, intervalValue = 90): ServiceScheduleAnchor {
  const lastDayMs = Date.UTC(2026, 5, 15) + (daysUntilDue - intervalValue) * MS_PER_DAY;
  return {
    intervalType: "CALENDAR_DAYS",
    intervalValue,
    lastServiceAt: new Date(lastDayMs).toISOString(),
    lastServiceOdometerKm: null,
    lastServiceEngineHours: null,
  };
}

describe("serviceScheduleState — DISTANCE_KM (default 500 km window)", () => {
  // anchor 0 + interval 5000 → nextDue 5000; remaining = 5000 − current.
  test("current past next-due → 'overdue'", () => {
    expect(
      serviceScheduleState(kmSchedule(0), { ...READING_BOTH, odometerCurrentKm: 5001 }, NOW),
    ).toBe("overdue");
    expect(
      serviceScheduleState(kmSchedule(0), { ...READING_BOTH, odometerCurrentKm: 99999 }, NOW),
    ).toBe("overdue");
  });

  test("current within 500 km of next-due → 'due-soon'", () => {
    expect(
      serviceScheduleState(kmSchedule(0), { ...READING_BOTH, odometerCurrentKm: 4600 }, NOW),
    ).toBe("due-soon");
  });

  test("exactly at next-due (remaining 0) → 'due-soon'", () => {
    expect(
      serviceScheduleState(kmSchedule(0), { ...READING_BOTH, odometerCurrentKm: 5000 }, NOW),
    ).toBe("due-soon");
  });

  test("further than 500 km out → 'ok'", () => {
    expect(
      serviceScheduleState(kmSchedule(0), { ...READING_BOTH, odometerCurrentKm: 0 }, NOW),
    ).toBe("ok");
  });

  test("the exact 500 km boundary: remaining 500 is 'due-soon', 501 is 'ok'", () => {
    // current 4500 → remaining 500 (inclusive edge); current 4499 → remaining 501.
    expect(
      serviceScheduleState(kmSchedule(0), { ...READING_BOTH, odometerCurrentKm: 4500 }, NOW),
    ).toBe("due-soon");
    expect(
      serviceScheduleState(kmSchedule(0), { ...READING_BOTH, odometerCurrentKm: 4499 }, NOW),
    ).toBe("ok");
  });

  test("a non-zero anchor shifts next-due (anchor 10000 + 5000 = 15000)", () => {
    expect(
      serviceScheduleState(kmSchedule(10000), { ...READING_BOTH, odometerCurrentKm: 15001 }, NOW),
    ).toBe("overdue");
    expect(
      serviceScheduleState(kmSchedule(10000), { ...READING_BOTH, odometerCurrentKm: 14700 }, NOW),
    ).toBe("due-soon");
    expect(
      serviceScheduleState(kmSchedule(10000), { ...READING_BOTH, odometerCurrentKm: 12000 }, NOW),
    ).toBe("ok");
  });
});

describe("serviceScheduleState — ENGINE_HOURS (default 250 tenths = 25 h window)", () => {
  // anchor 0 + interval 2500 → nextDue 2500 tenths; remaining = 2500 − current.
  test("current past next-due → 'overdue'", () => {
    expect(
      serviceScheduleState(hoursSchedule(0), { ...READING_BOTH, engineHoursCurrent: 2501 }, NOW),
    ).toBe("overdue");
  });

  test("within 250 tenths of next-due → 'due-soon'", () => {
    expect(
      serviceScheduleState(hoursSchedule(0), { ...READING_BOTH, engineHoursCurrent: 2400 }, NOW),
    ).toBe("due-soon");
  });

  test("the exact 250-tenths boundary: remaining 250 'due-soon', 251 'ok'", () => {
    // current 2250 → remaining 250 (edge); current 2249 → remaining 251.
    expect(
      serviceScheduleState(hoursSchedule(0), { ...READING_BOTH, engineHoursCurrent: 2250 }, NOW),
    ).toBe("due-soon");
    expect(
      serviceScheduleState(hoursSchedule(0), { ...READING_BOTH, engineHoursCurrent: 2249 }, NOW),
    ).toBe("ok");
  });

  test("far from next-due → 'ok'", () => {
    expect(
      serviceScheduleState(hoursSchedule(0), { ...READING_BOTH, engineHoursCurrent: 0 }, NOW),
    ).toBe("ok");
  });
});

describe("serviceScheduleState — null reading / null anchor → 'none'", () => {
  test("ENGINE_HOURS schedule on a vehicle with null engineHoursCurrent → 'none'", () => {
    // The headline case: "tracks hours" ≠ "has a reading". No badge yet.
    expect(
      serviceScheduleState(
        hoursSchedule(0),
        { odometerCurrentKm: 0, engineHoursCurrent: null },
        NOW,
      ),
    ).toBe("none");
  });

  test("a null meter anchor → 'none' (next-due cannot be derived)", () => {
    expect(
      serviceScheduleState(kmSchedule(null), { ...READING_BOTH, odometerCurrentKm: 9999 }, NOW),
    ).toBe("none");
    expect(
      serviceScheduleState(hoursSchedule(null), { ...READING_BOTH, engineHoursCurrent: 9999 }, NOW),
    ).toBe("none");
  });

  test("a null odometer reading → 'none' (defensive; odometer is non-null in practice)", () => {
    expect(
      serviceScheduleState(kmSchedule(0), { odometerCurrentKm: null, engineHoursCurrent: 0 }, NOW),
    ).toBe("none");
  });

  test("an unparseable lastServiceAt on a CALENDAR schedule → 'none'", () => {
    const bad: ServiceScheduleAnchor = {
      intervalType: "CALENDAR_DAYS",
      intervalValue: 30,
      lastServiceAt: "not-a-date",
      lastServiceOdometerKm: null,
      lastServiceEngineHours: null,
    };
    expect(serviceScheduleState(bad, READING_BOTH, NOW)).toBe("none");
  });
});

describe("serviceScheduleState — CALENDAR_DAYS (default 30-day window)", () => {
  test("next-due in the past → 'overdue'", () => {
    expect(serviceScheduleState(calendarSchedule(-1), READING_BOTH, NOW)).toBe("overdue");
    expect(serviceScheduleState(calendarSchedule(-365), READING_BOTH, NOW)).toBe("overdue");
  });

  test("next-due today (day 0) → 'due-soon'", () => {
    expect(serviceScheduleState(calendarSchedule(0), READING_BOTH, NOW)).toBe("due-soon");
  });

  test("the exact 30-day boundary: day 30 'due-soon', day 31 'ok'", () => {
    expect(serviceScheduleState(calendarSchedule(30), READING_BOTH, NOW)).toBe("due-soon");
    expect(serviceScheduleState(calendarSchedule(31), READING_BOTH, NOW)).toBe("ok");
  });

  test("next-due far out → 'ok'", () => {
    expect(serviceScheduleState(calendarSchedule(60), READING_BOTH, NOW)).toBe("ok");
  });

  test("the calendar case equals complianceBadgeState relabeled (the c7 reuse guarantee)", () => {
    // For each offset, the maintenance state is exactly the compliance state of
    // the SAME next-due date, with expired→overdue / expiring-soon→due-soon.
    const relabel = {
      none: "none",
      expired: "overdue",
      "expiring-soon": "due-soon",
      ok: "ok",
    } as const;
    for (const days of [-1, 0, 30, 31, 60]) {
      const schedule = calendarSchedule(days);
      const nextDueIso = nextDueForSchedule(schedule).dateIso;
      expect(nextDueIso).not.toBeNull();
      expect(serviceScheduleState(schedule, READING_BOTH, NOW)).toBe(
        relabel[complianceBadgeState(nextDueIso, NOW)],
      );
    }
  });
});

describe("serviceScheduleState — custom windows", () => {
  const WIDE: ServiceDueSoonWindows = {
    distanceKm: 1000,
    engineHoursTenths: 500,
    calendarDays: 60,
  };

  test("a km value 'ok' under 500 is 'due-soon' under 1000", () => {
    // anchor 0 + 5000 → nextDue 5000; current 4200 → remaining 800.
    const reading = { ...READING_BOTH, odometerCurrentKm: 4200 };
    expect(serviceScheduleState(kmSchedule(0), reading, NOW)).toBe("ok");
    expect(serviceScheduleState(kmSchedule(0), reading, NOW, WIDE)).toBe("due-soon");
  });

  test("an hours value 'ok' under 250 is 'due-soon' under 500", () => {
    // nextDue 2500; current 2100 → remaining 400.
    const reading = { ...READING_BOTH, engineHoursCurrent: 2100 };
    expect(serviceScheduleState(hoursSchedule(0), reading, NOW)).toBe("ok");
    expect(serviceScheduleState(hoursSchedule(0), reading, NOW, WIDE)).toBe("due-soon");
  });

  test("a calendar value 'ok' under 30 days is 'due-soon' under 60", () => {
    expect(serviceScheduleState(calendarSchedule(45), READING_BOTH, NOW)).toBe("ok");
    expect(serviceScheduleState(calendarSchedule(45), READING_BOTH, NOW, WIDE)).toBe("due-soon");
  });

  test("the documented provisional defaults are 500 / 250 / 30", () => {
    expect(DEFAULT_SERVICE_DUE_SOON_WINDOWS).toEqual({
      distanceKm: 500,
      engineHoursTenths: 250,
      calendarDays: 30,
    });
  });
});

describe("serviceScheduleState — CALENDAR UTC determinism across server timezones", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  function underTz(tz: string, fn: () => void): void {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  }

  test("the 30-day boundary classifies identically in zones west and east of UTC", () => {
    // Evening-UTC now + a midnight-UTC next-due — the combination a local-getter
    // regression would shift across the day boundary in far-east/west zones.
    const eveningNow = new Date("2026-06-15T20:00:00.000Z");
    const day30 = calendarSchedule(30); // inclusive edge → due-soon
    const day31 = calendarSchedule(31); // past the window → ok
    for (const tz of [
      "UTC",
      "Asia/Kathmandu",
      "America/Chicago",
      "America/Anchorage",
      "Pacific/Kiritimati",
    ]) {
      underTz(tz, () => {
        expect(serviceScheduleState(day30, READING_BOTH, eveningNow)).toBe("due-soon");
        expect(serviceScheduleState(day31, READING_BOTH, eveningNow)).toBe("ok");
      });
    }
  });
});

describe("nextDueForSchedule — the derived next-due value", () => {
  test("DISTANCE_KM → km = anchor + interval; other fields null", () => {
    expect(nextDueForSchedule(kmSchedule(1000))).toEqual({
      dateIso: null,
      km: 6000,
      engineHoursTenths: null,
    });
  });

  test("ENGINE_HOURS → engineHoursTenths = anchor + interval; other fields null", () => {
    expect(nextDueForSchedule(hoursSchedule(2000))).toEqual({
      dateIso: null,
      km: null,
      engineHoursTenths: 4500,
    });
  });

  test("CALENDAR_DAYS → dateIso is the next-due UTC midnight; other fields null", () => {
    const result = nextDueForSchedule(calendarSchedule(10));
    expect(result.km).toBeNull();
    expect(result.engineHoursTenths).toBeNull();
    // day 10 from 2026-06-15 is 2026-06-25 at UTC midnight.
    expect(result.dateIso).toBe("2026-06-25T00:00:00.000Z");
  });

  test("a null meter anchor → the active value is null (no badge, em-dash render)", () => {
    expect(nextDueForSchedule(kmSchedule(null)).km).toBeNull();
    expect(nextDueForSchedule(hoursSchedule(null)).engineHoursTenths).toBeNull();
  });

  test("an unparseable calendar lastServiceAt → dateIso null", () => {
    const bad: ServiceScheduleAnchor = {
      intervalType: "CALENDAR_DAYS",
      intervalValue: 30,
      lastServiceAt: "nope",
      lastServiceOdometerKm: null,
      lastServiceEngineHours: null,
    };
    expect(nextDueForSchedule(bad).dateIso).toBeNull();
  });
});
