import { afterEach, describe, expect, test } from "vitest";

import { BS_MONTHS, formatNepaliDate } from "../src/lib/nepali-date";

/**
 * Pins `formatNepaliDate` — the single web-side BS date formatter (ADR-0031,
 * DESIGN.md §"BS calendar" / §Data display), mirror of `money.test.ts` for
 * `formatNpr`. All correctness lives in this pure function; the
 * `<NepaliDate>` component is markup-only over it and ships untested-by-render
 * (no jsdom harness — vitest collects only `test/**`/`*.test.ts`).
 *
 * Every expected BS value here is the output of the verified conversion
 * library (`nepali-date-converter`), NOT a fabricated pair (DESIGN.md
 * anti-pattern #12). Where DESIGN.md's illustration and the library disagree,
 * the library wins (per ADR-0031) — see the `both` test below.
 */

describe("formatNepaliDate — variants and the DESIGN.md shape", () => {
  test("both (default) → '<BSyear> <BSmonth> <BSday> (<AD YYYY-MM-DD>)'", () => {
    // DESIGN.md's illustration writes "2082 Jestha 6" for 2026-05-20, but the
    // library — the verified source — converts it to 2083 Jestha 6 (BS 2083
    // Baishakh 1 ≈ 2026-04-14, so Jestha 6 = 2026-05-20). Per ADR-0031 we
    // match DESIGN.md for the SHAPE and trust the library for the VALUES.
    expect(formatNepaliDate("2026-05-20T00:00:00Z")).toBe("2083 Jestha 6 (2026-05-20)");
  });

  test("explicit { format: 'both' } equals the default", () => {
    expect(formatNepaliDate("2026-05-20T00:00:00Z", { format: "both" })).toBe(
      "2083 Jestha 6 (2026-05-20)",
    );
  });

  test("bs → BS only", () => {
    expect(formatNepaliDate("2026-05-20T00:00:00Z", { format: "bs" })).toBe("2083 Jestha 6");
  });

  test("en → Gregorian YYYY-MM-DD only (byte-identical to the old inline formatDate)", () => {
    expect(formatNepaliDate("2026-05-20T00:00:00Z", { format: "en" })).toBe("2026-05-20");
  });

  test("a date before the Nepali new year falls in the previous BS year", () => {
    // Jan 2026 is in BS 2082 (which began ~Apr 2025); May 2026 is BS 2083.
    // The same calendar surfaces both years — proof the year is a real
    // conversion, not a constant.
    expect(formatNepaliDate("2026-01-15T00:00:00Z")).toBe("2082 Magh 1 (2026-01-15)");
  });

  test("a near-future compliance-expiry date converts (calendar table covers it)", () => {
    expect(formatNepaliDate("2030-01-15T00:00:00Z")).toBe("2086 Magh 1 (2030-01-15)");
  });
});

describe("formatNepaliDate — em-dash for absent / unparseable (matches formatNpr)", () => {
  test("null → em-dash", () => {
    expect(formatNepaliDate(null)).toBe("—");
  });

  test("undefined → em-dash", () => {
    expect(formatNepaliDate(undefined)).toBe("—");
  });

  test("unparseable string → em-dash", () => {
    expect(formatNepaliDate("not-a-date")).toBe("—");
  });

  test("empty string → em-dash", () => {
    expect(formatNepaliDate("")).toBe("—");
  });

  test("absent input renders em-dash regardless of the requested format", () => {
    expect(formatNepaliDate(null, { format: "bs" })).toBe("—");
    expect(formatNepaliDate(null, { format: "en" })).toBe("—");
    expect(formatNepaliDate(undefined, { format: "both" })).toBe("—");
    expect(formatNepaliDate("garbage", { format: "en" })).toBe("—");
  });
});

describe("formatNepaliDate — month names come from the FleetCo-owned BS_MONTHS", () => {
  // The library's own English long-names differ at three indices
  // (Baisakh/Asar/Aswin); rendering from BS_MONTHS (ADR-0031 c2) is the
  // anti-drift guard that pins FleetCo's spelling so a library update can't
  // silently change a rendered month name.
  test("BS_MONTHS holds FleetCo's spelling at the three overridden indices", () => {
    expect(BS_MONTHS).toHaveLength(12);
    expect(BS_MONTHS[0]).toBe("Baishakh"); // library: "Baisakh"
    expect(BS_MONTHS[2]).toBe("Ashadh"); // library: "Asar"
    expect(BS_MONTHS[5]).toBe("Ashwin"); // library: "Aswin"
  });

  test("a Baishakh date renders FleetCo 'Baishakh', not library 'Baisakh'", () => {
    const out = formatNepaliDate("2026-04-20T00:00:00Z", { format: "bs" });
    expect(out).toBe("2083 Baishakh 7");
    expect(out).not.toContain("Baisakh");
  });

  test("an Ashadh date renders FleetCo 'Ashadh', not library 'Asar'", () => {
    const out = formatNepaliDate("2026-07-01T00:00:00Z", { format: "bs" });
    expect(out).toBe("2083 Ashadh 17");
    expect(out).not.toContain("Asar");
  });

  test("an Ashwin date renders FleetCo 'Ashwin', not library 'Aswin'", () => {
    const out = formatNepaliDate("2026-10-01T00:00:00Z", { format: "bs" });
    expect(out).toBe("2083 Ashwin 15");
    expect(out).not.toContain("Aswin");
  });
});

describe("formatNepaliDate — UTC-calendar-day rule (ADR-0031 c3), timezone-independent", () => {
  const ORIGINAL_TZ = process.env.TZ;
  afterEach(() => {
    // Belt-and-suspenders: each underTz() restores in its own finally, but if
    // an assertion throws we still leave the suite's TZ as it was found.
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  // Node re-runs tzset() on assignment to process.env.TZ, so this changes how
  // subsequent `new Date(...)` calls read local components — which is exactly
  // what the formatter's construction must be robust against.
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

  test("two instants on the same UTC day map to the same BS day", () => {
    const atMidnight = formatNepaliDate("2026-05-20T00:00:00Z", { format: "bs" });
    const lateInDay = formatNepaliDate("2026-05-20T23:00:00Z", { format: "bs" });
    expect(atMidnight).toBe("2083 Jestha 6");
    expect(lateInDay).toBe("2083 Jestha 6");
    expect(atMidnight).toBe(lateInDay);
  });

  test("conversion is identical across server timezones, west and east of UTC", () => {
    for (const tz of [
      "UTC",
      "Asia/Kathmandu",
      "America/Chicago",
      "America/Anchorage",
      "Pacific/Kiritimati",
    ]) {
      underTz(tz, () => {
        expect(formatNepaliDate("2026-05-20T00:00:00Z", { format: "bs" })).toBe("2083 Jestha 6");
        expect(formatNepaliDate("2026-05-20T23:00:00Z", { format: "bs" })).toBe("2083 Jestha 6");
      });
    }
  });

  test("the local-day construction is what keeps it correct (a Date.UTC build would be a day early)", () => {
    // This test both proves the environment honours the TZ switch and pins the
    // construction choice. In America/Chicago (west of UTC), a midnight-UTC
    // instant — `new Date(Date.UTC(y,m,d))`, the form the ADR's "e.g."
    // illustration shows — rolls back to the previous calendar day when read
    // with local getters (which is how the library reads a Date). The
    // formatter instead builds `new Date(y,m,d)` from the UTC components, so
    // it stays on the right day. If the formatter ever regresses to the
    // Date.UTC form, the BS assertion below flips to "2083 Jestha 5" and fails.
    underTz("America/Chicago", () => {
      const utcInstant = new Date(Date.UTC(2026, 4, 20));
      const localDay = new Date(2026, 4, 20);
      expect(utcInstant.getDate()).toBe(19); // proves the TZ switch took effect
      expect(localDay.getDate()).toBe(20);
      expect(formatNepaliDate("2026-05-20T00:00:00Z", { format: "bs" })).toBe("2083 Jestha 6");
    });
  });
});

describe("formatNepaliDate — Node/SSR safety smoke", () => {
  test("imports and converts in the Node test env with no window/DOM dependency", () => {
    // The pages that consume <NepaliDate> are server components; the converter
    // runs in Node during SSR. This test importing the formatter (which
    // imports the library at module load) and converting below proves the path
    // is Node-safe — a browser-coupled library would crash here, and the
    // env has no window/document (vitest's default node env, no jsdom).
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(formatNepaliDate("2030-01-15T00:00:00Z", { format: "bs" })).toBe("2086 Magh 1");
  });
});
