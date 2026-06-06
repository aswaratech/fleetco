import { afterEach, describe, expect, test } from "vitest";

import { complianceBadgeState, worstComplianceState } from "../src/lib/compliance";

/**
 * Pins the two pure compliance helpers (ADR-0031 commitment 5 / §E):
 *   - `complianceBadgeState` — classifies ONE compliance-document expiry date
 *     into a badge state.
 *   - `worstComplianceState` — the array-shaped sibling: the worst (most urgent)
 *     state across several expiries, built strictly on `complianceBadgeState`.
 *     This is the helper the sanctioned vehicles-list roll-up column consumes
 *     (ADR-0031 "Revisit when").
 *
 * All correctness lives in these pure functions; the `<Badge>` component is
 * markup-only and ships untested-by-render exactly like the money/units/BS
 * formatters' callers (no jsdom harness — vitest collects only
 * `test/**`/`*.test.ts` under the node env).
 *
 * The load-bearing rule is the UTC-calendar-day discipline (mirroring
 * `nepali-date.test.ts`): the 30-day boundary is computed on UTC calendar days,
 * so it is deterministic regardless of the server's timezone.
 */

// A fixed reference "now" with a non-midnight time-of-day, so the tests
// exercise the helper's truncation rather than accidentally feeding it a clean
// midnight. Its UTC calendar day is 2026-06-15.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// An ISO string for the UTC midnight `n` whole days from NOW's calendar day.
// Building from `Date.UTC(...)` + a day-multiple keeps every fixture on an
// unambiguous UTC midnight, so the calendar arithmetic is self-evident and
// doesn't depend on hand-counted month lengths.
function isoDaysFromNow(n: number): string {
  return new Date(Date.UTC(2026, 5, 15) + n * MS_PER_DAY).toISOString();
}

describe("complianceBadgeState — the four states", () => {
  test("an expiry before today → 'expired'", () => {
    expect(complianceBadgeState(isoDaysFromNow(-1), NOW)).toBe("expired");
    expect(complianceBadgeState(isoDaysFromNow(-365), NOW)).toBe("expired");
  });

  test("an expiry within the 30-day window → 'expiring-soon'", () => {
    expect(complianceBadgeState(isoDaysFromNow(1), NOW)).toBe("expiring-soon");
    expect(complianceBadgeState(isoDaysFromNow(15), NOW)).toBe("expiring-soon");
    expect(complianceBadgeState(isoDaysFromNow(29), NOW)).toBe("expiring-soon");
  });

  test("an expiry past the 30-day window → 'ok'", () => {
    expect(complianceBadgeState(isoDaysFromNow(60), NOW)).toBe("ok");
    expect(complianceBadgeState("2030-01-01T00:00:00.000Z", NOW)).toBe("ok");
  });

  test("null / undefined / unparseable / empty → 'none'", () => {
    expect(complianceBadgeState(null, NOW)).toBe("none");
    expect(complianceBadgeState(undefined, NOW)).toBe("none");
    expect(complianceBadgeState("not-a-date", NOW)).toBe("none");
    expect(complianceBadgeState("", NOW)).toBe("none");
  });
});

describe("complianceBadgeState — the exact 30-day boundary", () => {
  test("today (day 0) is 'expiring-soon', not 'expired'", () => {
    // The boundary is `expiry < now` (strict) for expired, so an expiry whose
    // UTC day equals today's is still in-window, never already expired.
    expect(complianceBadgeState(isoDaysFromNow(0), NOW)).toBe("expiring-soon");
  });

  test("yesterday (day -1) is 'expired'", () => {
    expect(complianceBadgeState(isoDaysFromNow(-1), NOW)).toBe("expired");
  });

  test("day 30 (the inclusive edge) is 'expiring-soon'", () => {
    expect(complianceBadgeState(isoDaysFromNow(30), NOW)).toBe("expiring-soon");
  });

  test("day 31 (one past the edge) is 'ok'", () => {
    expect(complianceBadgeState(isoDaysFromNow(31), NOW)).toBe("ok");
  });
});

describe("complianceBadgeState — UTC calendar DAY, not instant", () => {
  test("an expiry earlier in the same UTC day than `now` is still 'expiring-soon'", () => {
    // Instant-wise the expiry is BEFORE now, but both fall on 2026-06-15 UTC,
    // so day-wise they are the same day → in-window, not expired. This pins
    // that the comparison is calendar-day, not instant.
    const lateNow = new Date("2026-06-15T23:59:00.000Z");
    const earlyExpirySameDay = "2026-06-15T00:00:01.000Z";
    expect(complianceBadgeState(earlyExpirySameDay, lateNow)).toBe("expiring-soon");
  });
});

describe("complianceBadgeState — custom windowDays", () => {
  test("a 60-day window pulls day-45 into 'expiring-soon'", () => {
    expect(complianceBadgeState(isoDaysFromNow(45), NOW, 60)).toBe("expiring-soon");
  });

  test("the same day-45 expiry is 'ok' under the default 30-day window", () => {
    expect(complianceBadgeState(isoDaysFromNow(45), NOW)).toBe("ok");
  });

  test("a 0-day window makes today the inclusive edge ('expiring-soon') and tomorrow 'ok'", () => {
    expect(complianceBadgeState(isoDaysFromNow(0), NOW, 0)).toBe("expiring-soon");
    expect(complianceBadgeState(isoDaysFromNow(1), NOW, 0)).toBe("ok");
  });
});

describe("complianceBadgeState — UTC determinism across server timezones", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    // Belt-and-suspenders: each underTz() restores in its own finally, but if
    // an assertion throws we still leave the suite's TZ as it was found.
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  // Node re-runs tzset() on assignment to process.env.TZ, so this changes how
  // subsequent `new Date(...)` calls read LOCAL components — which is exactly
  // what the helper's UTC-day truncation must be robust against.
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

  test("the boundary classifies identically across zones west and east of UTC", () => {
    // `now` is evening UTC (20:00) and the expiry is a midnight-UTC date — the
    // combination where a LOCAL-getter implementation would shift one operand
    // across the day boundary in far-east/west zones and misclassify. The
    // helper reads getUTC* on both, so every zone agrees. A regression to
    // local getters would flip one of these in Kiritimati / Anchorage and fail.
    const eveningNow = new Date("2026-06-15T20:00:00.000Z");
    const day30 = "2026-07-15T00:00:00.000Z"; // exactly 30 days out (inclusive)
    const day31 = "2026-07-16T00:00:00.000Z"; // 31 days out (past the window)
    for (const tz of [
      "UTC",
      "Asia/Kathmandu",
      "America/Chicago",
      "America/Anchorage",
      "Pacific/Kiritimati",
    ]) {
      underTz(tz, () => {
        expect(complianceBadgeState(day30, eveningNow)).toBe("expiring-soon");
        expect(complianceBadgeState(day31, eveningNow)).toBe("ok");
      });
    }
  });

  test("a fixed expiry/now pair yields one state in every zone", () => {
    for (const tz of ["UTC", "Asia/Kathmandu", "America/Chicago", "Pacific/Kiritimati"]) {
      underTz(tz, () => {
        expect(complianceBadgeState(isoDaysFromNow(-1), NOW)).toBe("expired");
        expect(complianceBadgeState(isoDaysFromNow(0), NOW)).toBe("expiring-soon");
        expect(complianceBadgeState(isoDaysFromNow(30), NOW)).toBe("expiring-soon");
        expect(complianceBadgeState(isoDaysFromNow(31), NOW)).toBe("ok");
      });
    }
  });
});

describe("worstComplianceState — the worst of several expiries", () => {
  test("empty list → 'none' (the reduce floor)", () => {
    expect(worstComplianceState([], NOW)).toBe("none");
  });

  test("all null / undefined → 'none'", () => {
    expect(worstComplianceState([null, undefined, null], NOW)).toBe("none");
  });

  test("all current ('ok') → 'ok'", () => {
    expect(worstComplianceState([isoDaysFromNow(60), isoDaysFromNow(90)], NOW)).toBe("ok");
  });

  test("a single current document among unscanned → 'ok' (ok outranks none)", () => {
    expect(worstComplianceState([null, isoDaysFromNow(60), undefined], NOW)).toBe("ok");
  });

  test("a single 'expiring-soon' → 'expiring-soon'", () => {
    expect(worstComplianceState([isoDaysFromNow(10)], NOW)).toBe("expiring-soon");
  });

  test("expiring-soon outranks ok and none", () => {
    expect(worstComplianceState([isoDaysFromNow(60), isoDaysFromNow(10), null], NOW)).toBe(
      "expiring-soon",
    );
  });

  test("one expired + one expiring-soon → 'expired'", () => {
    expect(worstComplianceState([isoDaysFromNow(-1), isoDaysFromNow(10)], NOW)).toBe("expired");
  });

  test("expired wins regardless of position in the list", () => {
    expect(
      worstComplianceState([isoDaysFromNow(60), isoDaysFromNow(10), isoDaysFromNow(-5)], NOW),
    ).toBe("expired");
    expect(
      worstComplianceState([isoDaysFromNow(-5), isoDaysFromNow(10), isoDaysFromNow(60)], NOW),
    ).toBe("expired");
  });

  test("the exact three-document call the vehicles-list column makes", () => {
    // [bluebook, insurance, routePermit]: a lapsed bluebook, a soon-expiring
    // insurance, and an unscanned route permit roll up to the worst — expired.
    expect(worstComplianceState([isoDaysFromNow(-2), isoDaysFromNow(20), null], NOW)).toBe(
      "expired",
    );
  });

  test("forwards a custom windowDays to complianceBadgeState (not re-derived)", () => {
    // day-45 is 'ok' under the default 30-day window but 'expiring-soon' under a
    // 60-day window — proving windowDays is forwarded per expiry, not hardcoded.
    expect(worstComplianceState([isoDaysFromNow(45)], NOW)).toBe("ok");
    expect(worstComplianceState([isoDaysFromNow(45)], NOW, 60)).toBe("expiring-soon");
  });

  test("over a single expiry it equals complianceBadgeState for every state", () => {
    // The "built strictly on the shipped helper" guarantee: a one-element
    // roll-up is exactly the scalar classification, for each of the four states.
    for (const days of [-1, 0, 30, 31, 60]) {
      const iso = isoDaysFromNow(days);
      expect(worstComplianceState([iso], NOW)).toBe(complianceBadgeState(iso, NOW));
    }
  });
});

describe("worstComplianceState — UTC determinism inherited from complianceBadgeState", () => {
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

  test("a mixed roll-up classifies identically in every zone", () => {
    // The wrapper only reduces over complianceBadgeState, which truncates both
    // operands to their UTC calendar day, so the worst-of result is zone-
    // independent. An evening-UTC `now` against midnight-UTC expiries is the
    // combination a local-getter regression would shift across a day boundary.
    const eveningNow = new Date("2026-06-15T20:00:00.000Z");
    const expiries = [
      "2026-07-15T00:00:00.000Z", // day 30 — expiring-soon (inclusive edge)
      "2026-07-16T00:00:00.000Z", // day 31 — ok
      null, // unscanned — none
    ];
    for (const tz of [
      "UTC",
      "Asia/Kathmandu",
      "America/Chicago",
      "America/Anchorage",
      "Pacific/Kiritimati",
    ]) {
      underTz(tz, () => {
        expect(worstComplianceState(expiries, eveningNow)).toBe("expiring-soon");
      });
    }
  });
});
