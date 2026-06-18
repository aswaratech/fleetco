import { bsFiscalYear } from "@fleetco/shared";
import { afterEach, describe, expect, test } from "vitest";

// Pure unit tests for the Bikram Sambat fiscal-year derivation (Program D /
// ADR-0039 c4). bsFiscalYear lives in @fleetco/shared (the wrap-the-vendor home
// for the BS converter, ADR-0031); the invoice numbering (D3) keys its gapless
// per-series counter by the returned `label` and embeds it in the number
// (INV-2082-83-00001). No DB — this pins the calendar logic itself.
//
// The Nepali fiscal year runs Shrawan 1 → Ashadh end (mid-July to mid-July; the
// glossary). The load-bearing case is the boundary: a date in Ashadh belongs to
// the fiscal year that STARTED the previous Shrawan, so the fiscal year is NOT
// simply the BS calendar year. The Gregorian↔BS values below were verified
// against nepali-date-converter@3.4.0 (the same library formatNepaliDate uses).

describe("bsFiscalYear — fiscal-year boundary (Shrawan→Ashadh)", () => {
  test("Ashadh 32 (the LAST day of a fiscal year) keys the year that started the prior Shrawan", () => {
    // 2025-07-16 → BS 2082 Ashadh 32 → FY 2081-82 (its final day).
    const fy = bsFiscalYear("2025-07-16T00:00:00.000Z");
    expect(fy).toEqual({ startYear: 2081, endYear: 2082, label: "2081-82" });
  });

  test("Shrawan 1 (the FIRST day of the next fiscal year) flips the label", () => {
    // 2025-07-17 → BS 2082 Shrawan 1 → FY 2082-83 (its first day). The adjacent
    // calendar day to the case above, but a different fiscal year — the boundary.
    const fy = bsFiscalYear("2025-07-17T00:00:00.000Z");
    expect(fy).toEqual({ startYear: 2082, endYear: 2083, label: "2082-83" });
  });

  test("mid-Shrawan sits in the fiscal year that just started", () => {
    // 2025-08-01 → BS 2082 Shrawan 16 → FY 2082-83.
    expect(bsFiscalYear("2025-08-01T00:00:00.000Z")?.label).toBe("2082-83");
  });

  test("Ashadh of the NEXT calendar year still keys the earlier-started fiscal year", () => {
    // 2026-06-19 (today, the build date) → BS 2083 Ashadh 5 → FY 2082-83. An
    // invoice issued today therefore numbers INV-2082-83-NNNNN.
    expect(bsFiscalYear("2026-06-19T00:00:00.000Z")?.label).toBe("2082-83");
  });

  test("the following Shrawan rolls to the next fiscal year", () => {
    // 2026-08-01 → BS 2083 Shrawan 16 → FY 2083-84.
    expect(bsFiscalYear("2026-08-01T00:00:00.000Z")?.label).toBe("2083-84");
  });

  test("a mid-FY winter month keys the fiscal year that started the prior Shrawan", () => {
    // 2027-01-15 → BS 2083 Magh 1 → FY 2083-84 (Magh is after Shrawan 2083).
    expect(bsFiscalYear("2027-01-15T00:00:00.000Z")?.label).toBe("2083-84");
  });

  test("Baishakh 1 (BS new year, BEFORE Shrawan) still keys the running fiscal year", () => {
    // 2025-04-14 → BS 2082 Baishakh 1 → FY 2081-82 (Baishakh precedes Shrawan, so
    // it is the tail of the fiscal year that started the previous Shrawan 2081).
    expect(bsFiscalYear("2025-04-14T00:00:00.000Z")?.label).toBe("2081-82");
  });
});

describe("bsFiscalYear — label shape", () => {
  test("label is <startYear>-<endYear mod 100>, two zero-padded end digits", () => {
    const fy = bsFiscalYear("2025-08-01T00:00:00.000Z");
    expect(fy?.startYear).toBe(2082);
    expect(fy?.endYear).toBe(2083);
    expect(fy?.label).toBe("2082-83");
  });
});

describe("bsFiscalYear — absent / unparseable input degrades to null", () => {
  test.each([null, undefined, "", "not-a-date", "2026-13-99T00:00:00Z"])(
    "%s → null (caller surfaces a clear error, never a fabricated year)",
    (input) => {
      expect(bsFiscalYear(input as string | null | undefined)).toBeNull();
    },
  );
});

describe("bsFiscalYear — timezone-independent (UTC-calendar-day rule, ADR-0031 c3)", () => {
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

  test("the Shrawan-1 boundary resolves to the same fiscal year in every server zone", () => {
    // West and east of UTC. The boundary instant must not slide a day (which
    // would flip the fiscal year) regardless of the server's timezone — the same
    // discipline formatNepaliDate is pinned on.
    for (const tz of [
      "UTC",
      "Asia/Kathmandu",
      "America/Chicago",
      "America/Anchorage",
      "Pacific/Kiritimati",
    ]) {
      underTz(tz, () => {
        expect(bsFiscalYear("2025-07-16T00:00:00.000Z")?.label).toBe("2081-82");
        expect(bsFiscalYear("2025-07-17T00:00:00.000Z")?.label).toBe("2082-83");
      });
    }
  });
});
