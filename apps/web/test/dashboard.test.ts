import { afterEach, describe, expect, test } from "vitest";

import {
  currentMonthRange,
  rollUpCompliance,
  rollUpServiceSchedules,
  vehicleComplianceState,
  type VehicleComplianceFields,
} from "../src/lib/dashboard";
import type { ScheduleWithReading } from "../src/lib/maintenance";

/**
 * Pins the Home-dashboard data layer's PURE helpers (D1):
 *   - vehicleComplianceState — worst-of-three document precedence
 *   - rollUpCompliance       — per-vehicle, once-each compliance counts
 *   - currentMonthRange      — first-of-month → today, UTC-deterministic
 *
 * `loadDashboard()` itself is NOT tested here: it does network I/O (apiFetch),
 * which these pure tests deliberately avoid (mirroring compliance.test.ts /
 * money.test.ts — node env, no jsdom, no fetch). The worst-of / roll-up logic
 * builds strictly on the already-tested `complianceBadgeState`
 * (test/compliance.test.ts), so we test the COMPOSITION here — the worst-of
 * precedence and the once-each tally — not the 30-day rule a second time.
 */

// A fixed reference "now" with a non-midnight time-of-day so the helpers
// exercise their UTC-day truncation rather than a clean midnight. Its UTC
// calendar day is 2026-06-15 — the same NOW compliance.test.ts uses, so the
// day-offset fixtures line up with that suite.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// An ISO string for UTC midnight `n` whole days from NOW's calendar day.
// Building from `Date.UTC(...)` + a day-multiple keeps every fixture on an
// unambiguous UTC midnight, so the calendar arithmetic is self-evident.
function isoDaysFromNow(n: number): string {
  return new Date(Date.UTC(2026, 5, 15) + n * MS_PER_DAY).toISOString();
}

// A vehicle fixture carrying only the three compliance-expiry fields the
// helpers read; each defaults to null (document unscanned) unless overridden.
function vehicle(fields: Partial<VehicleComplianceFields> = {}): VehicleComplianceFields {
  return {
    bluebookExpiresAt: null,
    insuranceExpiresAt: null,
    routePermitExpiresAt: null,
    ...fields,
  };
}

describe("vehicleComplianceState — worst of the three documents", () => {
  test("expired outranks expiring-soon", () => {
    expect(
      vehicleComplianceState(
        vehicle({ bluebookExpiresAt: isoDaysFromNow(-1), insuranceExpiresAt: isoDaysFromNow(10) }),
        NOW,
      ),
    ).toBe("expired");
  });

  test("expiring-soon outranks ok", () => {
    expect(
      vehicleComplianceState(
        vehicle({ bluebookExpiresAt: isoDaysFromNow(10), insuranceExpiresAt: isoDaysFromNow(60) }),
        NOW,
      ),
    ).toBe("expiring-soon");
  });

  test("ok outranks none (one current document, two unscanned)", () => {
    expect(vehicleComplianceState(vehicle({ routePermitExpiresAt: isoDaysFromNow(60) }), NOW)).toBe(
      "ok",
    );
  });

  test("all three unscanned → none", () => {
    expect(vehicleComplianceState(vehicle(), NOW)).toBe("none");
  });

  test("precedence is independent of which slot holds the worst date", () => {
    // `expired` in the third slot still wins over `ok`/`expiring-soon` in the
    // first two — the worst-of reduce is order-independent.
    expect(
      vehicleComplianceState(
        vehicle({
          bluebookExpiresAt: isoDaysFromNow(60), // ok
          insuranceExpiresAt: isoDaysFromNow(10), // expiring-soon
          routePermitExpiresAt: isoDaysFromNow(-1), // expired
        }),
        NOW,
      ),
    ).toBe("expired");
  });
});

describe("rollUpCompliance — each vehicle counted once by its worst state", () => {
  test("a vehicle with one expired + one expiring-soon counts once as expired", () => {
    const rollUp = rollUpCompliance(
      [vehicle({ bluebookExpiresAt: isoDaysFromNow(-1), insuranceExpiresAt: isoDaysFromNow(10) })],
      NOW,
    );
    expect(rollUp).toEqual({ expiredCount: 1, expiringSoonCount: 0, total: 1 });
  });

  test("all-ok and all-null vehicles count toward neither bucket", () => {
    const rollUp = rollUpCompliance(
      [
        vehicle({
          bluebookExpiresAt: isoDaysFromNow(60),
          insuranceExpiresAt: isoDaysFromNow(90),
          routePermitExpiresAt: isoDaysFromNow(120),
        }),
        vehicle(),
      ],
      NOW,
    );
    expect(rollUp).toEqual({ expiredCount: 0, expiringSoonCount: 0, total: 2 });
  });

  test("empty fleet → all zeros", () => {
    expect(rollUpCompliance([], NOW)).toEqual({
      expiredCount: 0,
      expiringSoonCount: 0,
      total: 0,
    });
  });

  test("a mixed fleet tallies the correct counts", () => {
    const fleet = [
      vehicle({ bluebookExpiresAt: isoDaysFromNow(-1) }), // expired
      vehicle({ insuranceExpiresAt: isoDaysFromNow(10) }), // expiring-soon
      vehicle({ routePermitExpiresAt: isoDaysFromNow(5) }), // expiring-soon
      vehicle({ bluebookExpiresAt: isoDaysFromNow(60) }), // ok → neither bucket
      vehicle(), // none → neither bucket
      vehicle({
        bluebookExpiresAt: isoDaysFromNow(-5), // expired wins over…
        insuranceExpiresAt: isoDaysFromNow(5), // …its expiring-soon sibling
      }), // expired
    ];
    expect(rollUpCompliance(fleet, NOW)).toEqual({
      expiredCount: 2,
      expiringSoonCount: 2,
      total: 6,
    });
  });
});

describe("rollUpServiceSchedules — each ACTIVE schedule tallied by its own state", () => {
  // A DISTANCE_KM (schedule, reading) pair: anchor 0 + interval 5000 → next-due
  // 5000; the default 500 km window puts due-soon at current ∈ [4500, 5000] and
  // overdue at current > 5000. A null anchor → none (no badge yet).
  function kmPair(currentKm: number, anchor: number | null = 0): ScheduleWithReading {
    return {
      schedule: {
        intervalType: "DISTANCE_KM",
        intervalValue: 5000,
        lastServiceAt: NOW.toISOString(),
        lastServiceOdometerKm: anchor,
        lastServiceEngineHours: null,
      },
      vehicle: { odometerCurrentKm: currentKm, engineHoursCurrent: null },
    };
  }

  test("empty set → all zeros", () => {
    expect(rollUpServiceSchedules([], NOW)).toEqual({
      overdueCount: 0,
      dueSoonCount: 0,
      total: 0,
    });
  });

  test("a mixed set tallies overdue + due-soon; ok and none count toward neither", () => {
    const items = [
      kmPair(5001), // remaining -1 → overdue
      kmPair(4600), // remaining 400 → due-soon
      kmPair(4500), // remaining 500 (edge) → due-soon
      kmPair(0), // remaining 5000 → ok (neither bucket)
      kmPair(9999, null), // null anchor → none (neither bucket)
    ];
    expect(rollUpServiceSchedules(items, NOW)).toEqual({
      overdueCount: 1,
      dueSoonCount: 2,
      total: 5, // total counts every schedule scanned, including ok / none
    });
  });

  test("each schedule is its own unit — two due schedules on one vehicle both count", () => {
    // Unlike compliance (a vehicle counted once), a vehicle's multiple schedules
    // each tally independently. Both pairs read overdue.
    expect(rollUpServiceSchedules([kmPair(6000), kmPair(7000)], NOW)).toEqual({
      overdueCount: 2,
      dueSoonCount: 0,
      total: 2,
    });
  });
});

describe("currentMonthRange — first-of-month → today as YYYY-MM-DD", () => {
  test("mid-month: from = first of month, to = today", () => {
    expect(currentMonthRange(NOW)).toEqual({ from: "2026-06-01", to: "2026-06-15" });
  });

  test("on the first of the month, from equals to", () => {
    expect(currentMonthRange(new Date("2026-06-01T00:00:00.000Z"))).toEqual({
      from: "2026-06-01",
      to: "2026-06-01",
    });
  });

  test("last day of the month: to is that day, never a rollover into next month", () => {
    expect(currentMonthRange(new Date("2026-12-31T23:00:00.000Z"))).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  test("single-digit month and day are zero-padded", () => {
    expect(currentMonthRange(new Date("2026-03-05T12:00:00.000Z"))).toEqual({
      from: "2026-03-01",
      to: "2026-03-05",
    });
  });
});

describe("currentMonthRange — UTC determinism across server timezones", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    // Belt-and-suspenders: each underTz() restores in its own finally, but if
    // an assertion throws we still leave the suite's TZ as it was found.
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  // Node re-runs tzset() on assignment to process.env.TZ, so this changes how
  // subsequent `new Date(...)` calls read LOCAL components — exactly what the
  // helper's UTC-day reads (getUTC* / Date.UTC) must be robust against.
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

  test("a fixed instant yields the same window in every zone", () => {
    for (const tz of [
      "UTC",
      "Asia/Kathmandu",
      "America/Chicago",
      "America/Anchorage",
      "Pacific/Kiritimati",
    ]) {
      underTz(tz, () => {
        expect(currentMonthRange(NOW)).toEqual({ from: "2026-06-01", to: "2026-06-15" });
      });
    }
  });

  test("an instant just after a UTC month boundary does not roll back a day or month in any zone", () => {
    // 2026-03-01T00:30Z is still Feb 28 LOCAL in zones west of UTC (e.g.
    // Anchorage, UTC-9) — a local-getter implementation would return the
    // February window there. Reading getUTC* keeps every zone on March 1.
    const justAfterBoundary = new Date("2026-03-01T00:30:00.000Z");
    for (const tz of ["UTC", "Asia/Kathmandu", "America/Anchorage", "Pacific/Kiritimati"]) {
      underTz(tz, () => {
        expect(currentMonthRange(justAfterBoundary)).toEqual({
          from: "2026-03-01",
          to: "2026-03-01",
        });
      });
    }
  });
});
