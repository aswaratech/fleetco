import { afterEach, describe, expect, test } from "vitest";

import { BS_MONTHS } from "../src/lib/nepali-date";
import {
  BS_MAX_YEAR,
  BS_MIN_YEAR,
  WEEKDAY_LABELS,
  bsDayToIso,
  bsMonthLength,
  buildMonthGrid,
  initialBsMonth,
  isoToBsMonth,
  isoToUtcDay,
  stepBsMonth,
  stepBsYear,
} from "../src/lib/nepali-date-picker";

/**
 * Pins the pure BS date-PICKER helpers (ADR-0032) — the input twin of
 * `nepali-date.test.ts`. All correctness lives in these pure functions; the
 * `<NepaliDatePicker>` component is the markup-only shell and ships
 * untested-by-render (no jsdom harness — vitest collects only
 * `test/**`/`*.test.ts`), same posture as the display side.
 *
 * Every expected AD value here is the output of the verified conversion library
 * (`nepali-date-converter`), NOT a fabricated pair (DESIGN.md anti-pattern #12)
 * — locked against the library at build time across timezones.
 */

describe("bsDayToIso — the load-bearing BS→ISO selection mapping", () => {
  // BS 2083 Jestha 6 ≈ 2026-05-20 (the same anchor `nepali-date.test.ts` uses
  // for the display direction). A picked BS day must emit the EXACT ISO string
  // the native <input type="date"> submits — this is that round-trip.
  test("BS 2083 Jestha 6 → 2026-05-20 (round-trips the native-input string)", () => {
    expect(bsDayToIso(2083, 1, 6)).toBe("2026-05-20");
  });

  test("BS 2083 Baishakh 1 / 7 → 2026-04-14 / 2026-04-20", () => {
    expect(bsDayToIso(2083, 0, 1)).toBe("2026-04-14");
    expect(bsDayToIso(2083, 0, 7)).toBe("2026-04-20");
  });

  test("BS 2082 Magh 1 → 2026-01-15 (inverse of the display formatter)", () => {
    expect(bsDayToIso(2082, 9, 1)).toBe("2026-01-15");
  });

  test("zero-pads single-digit AD month and day", () => {
    // BS 2082 Magh 1 = 2026-01-15 already exercises a single-digit month.
    expect(bsDayToIso(2082, 9, 1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("buildMonthGrid — a known BS month's cells map to the right AD dates", () => {
  const grid = buildMonthGrid({ year: 2083, month: 1 }); // Jestha 2083

  test("month identity comes from the FleetCo BS_MONTHS array", () => {
    expect(grid.year).toBe(2083);
    expect(grid.month).toBe(1);
    expect(grid.monthName).toBe("Jestha");
    expect(grid.monthName).toBe(BS_MONTHS[1]);
  });

  test("leadingBlanks is the weekday of day 1 (Jestha 2083 day 1 = Friday = 5)", () => {
    expect(grid.leadingBlanks).toBe(5);
  });

  test("the month has 31 day cells, day 1 → day 31", () => {
    expect(grid.cells).toHaveLength(31);
    expect(grid.cells[0]?.bsDay).toBe(1);
    expect(grid.cells[30]?.bsDay).toBe(31);
  });

  test("each cell maps to the correct Gregorian calendar day", () => {
    expect(grid.cells[0]?.adIso).toBe("2026-05-15"); // Jestha 1
    expect(grid.cells[5]?.adIso).toBe("2026-05-20"); // Jestha 6
    expect(grid.cells[30]?.adIso).toBe("2026-06-14"); // Jestha 31 (last day)
  });

  test("cell adIso equals bsDayToIso for the same day (one BS→ISO path)", () => {
    for (const cell of grid.cells) {
      expect(cell.adIso).toBe(bsDayToIso(2083, 1, cell.bsDay));
    }
  });

  test("a month whose name FleetCo overrides renders FleetCo's spelling", () => {
    // The library spells these "Asar" / "Aswin"; the grid must show FleetCo's.
    expect(buildMonthGrid({ year: 2083, month: 2 }).monthName).toBe("Ashadh");
    expect(buildMonthGrid({ year: 2083, month: 5 }).monthName).toBe("Ashwin");
    expect(buildMonthGrid({ year: 2083, month: 0 }).monthName).toBe("Baishakh");
  });
});

describe("buildMonthGrid — today and selected day are located on the right cell", () => {
  test("today is the only cell flagged isToday", () => {
    const grid = buildMonthGrid(
      { year: 2083, month: 1 },
      { todayIso: "2026-05-20T10:30:00Z" }, // any instant on the UTC day
    );
    const todayCells = grid.cells.filter((c) => c.isToday);
    expect(todayCells).toHaveLength(1);
    expect(todayCells[0]?.bsDay).toBe(6);
    expect(todayCells[0]?.adIso).toBe("2026-05-20");
  });

  test("the selected value is the only cell flagged isSelected", () => {
    const grid = buildMonthGrid({ year: 2083, month: 1 }, { selectedIso: "2026-05-20" });
    const selected = grid.cells.filter((c) => c.isSelected);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.bsDay).toBe(6);
  });

  test("a month with no today/selected in it flags nothing", () => {
    const grid = buildMonthGrid(
      { year: 2083, month: 1 },
      { todayIso: "2020-01-01", selectedIso: "2020-01-01" },
    );
    expect(grid.cells.some((c) => c.isToday)).toBe(false);
    expect(grid.cells.some((c) => c.isSelected)).toBe(false);
  });

  test("null / absent today and selected flag nothing (no throw)", () => {
    const grid = buildMonthGrid({ year: 2083, month: 1 });
    expect(grid.cells.some((c) => c.isToday)).toBe(false);
    expect(grid.cells.some((c) => c.isSelected)).toBe(false);
    const grid2 = buildMonthGrid(
      { year: 2083, month: 1 },
      { todayIso: null, selectedIso: undefined },
    );
    expect(grid2.cells.some((c) => c.isSelected)).toBe(false);
  });
});

describe("bsMonthLength — variable BS month lengths from the library", () => {
  test("Jestha 2083 has 31 days", () => {
    expect(bsMonthLength(2083, 1)).toBe(31);
  });

  test("Magh 2082 has 29 days", () => {
    expect(bsMonthLength(2082, 9)).toBe(29);
  });

  test("the top-of-table boundary month does not throw", () => {
    // BS 2090 Chaitra: the next month (2091) is out of the table. The probe
    // catches the throw and returns the in-table length rather than crashing.
    expect(bsMonthLength(BS_MAX_YEAR, 11)).toBeGreaterThanOrEqual(29);
    expect(bsMonthLength(BS_MAX_YEAR, 11)).toBeLessThanOrEqual(32);
  });
});

describe("stepBsMonth / stepBsYear — navigation wraps year boundaries and clamps", () => {
  test("stepping forward past Chaitra wraps into the next BS year", () => {
    expect(stepBsMonth({ year: 2083, month: 11 }, 1)).toEqual({ year: 2084, month: 0 });
  });

  test("stepping back before Baishakh wraps into the previous BS year", () => {
    expect(stepBsMonth({ year: 2083, month: 0 }, -1)).toEqual({ year: 2082, month: 11 });
  });

  test("stepping within a year only changes the month", () => {
    expect(stepBsMonth({ year: 2083, month: 4 }, 1)).toEqual({ year: 2083, month: 5 });
    expect(stepBsMonth({ year: 2083, month: 4 }, -1)).toEqual({ year: 2083, month: 3 });
  });

  test("stepBsYear changes the year and keeps the month", () => {
    expect(stepBsYear({ year: 2083, month: 6 }, 1)).toEqual({ year: 2084, month: 6 });
    expect(stepBsYear({ year: 2083, month: 6 }, -1)).toEqual({ year: 2082, month: 6 });
  });

  test("navigation clamps to the converter's table range", () => {
    expect(stepBsMonth({ year: BS_MIN_YEAR, month: 0 }, -1)).toEqual({
      year: BS_MIN_YEAR,
      month: 0,
    });
    expect(stepBsMonth({ year: BS_MAX_YEAR, month: 11 }, 1)).toEqual({
      year: BS_MAX_YEAR,
      month: 11,
    });
    expect(stepBsYear({ year: BS_MAX_YEAR, month: 3 }, 5)).toEqual({
      year: BS_MAX_YEAR,
      month: 3,
    });
    expect(stepBsYear({ year: BS_MIN_YEAR, month: 3 }, -5)).toEqual({
      year: BS_MIN_YEAR,
      month: 3,
    });
  });
});

describe("isoToUtcDay / isoToBsMonth / initialBsMonth", () => {
  test("isoToUtcDay normalizes any instant to its UTC calendar day", () => {
    expect(isoToUtcDay("2026-05-20")).toBe("2026-05-20");
    expect(isoToUtcDay("2026-05-20T23:59:00Z")).toBe("2026-05-20");
  });

  test("isoToUtcDay returns null for absent / unparseable input", () => {
    expect(isoToUtcDay(null)).toBeNull();
    expect(isoToUtcDay(undefined)).toBeNull();
    expect(isoToUtcDay("")).toBeNull();
    expect(isoToUtcDay("not-a-date")).toBeNull();
  });

  test("isoToBsMonth returns the BS month a date falls in", () => {
    expect(isoToBsMonth("2026-05-20")).toEqual({ year: 2083, month: 1 });
    expect(isoToBsMonth("2026-01-15")).toEqual({ year: 2082, month: 9 });
    expect(isoToBsMonth(null)).toBeNull();
  });

  test("initialBsMonth opens to the selected value's month when set", () => {
    expect(initialBsMonth({ selectedIso: "2026-05-20", todayIso: "2026-01-15" })).toEqual({
      year: 2083,
      month: 1,
    });
  });

  test("initialBsMonth falls back to today's month when no value is set", () => {
    expect(initialBsMonth({ selectedIso: null, todayIso: "2026-01-15" })).toEqual({
      year: 2082,
      month: 9,
    });
    expect(initialBsMonth({ todayIso: "2026-05-20" })).toEqual({ year: 2083, month: 1 });
  });
});

describe("WEEKDAY_LABELS — Sunday-first, seven columns", () => {
  test("seven Latin two-letter labels starting Sunday", () => {
    expect(WEEKDAY_LABELS).toHaveLength(7);
    expect(WEEKDAY_LABELS[0]).toBe("Su");
    expect(WEEKDAY_LABELS[6]).toBe("Sa");
  });
});

describe("the picker is timezone-independent (ADR-0032 commitment 3)", () => {
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

  test("bsDayToIso and the grid produce the same AD days in every server zone", () => {
    for (const tz of [
      "UTC",
      "Asia/Kathmandu",
      "America/Chicago",
      "America/Anchorage",
      "Pacific/Kiritimati",
    ]) {
      underTz(tz, () => {
        // The load-bearing round-trip: a picked day emits the same ISO string
        // regardless of server timezone (a Date.UTC-based build would drift).
        expect(bsDayToIso(2083, 1, 6)).toBe("2026-05-20");

        const grid = buildMonthGrid(
          { year: 2083, month: 1 },
          { todayIso: "2026-05-20T00:00:00Z", selectedIso: "2026-05-20T23:00:00Z" },
        );
        expect(grid.cells[0]?.adIso).toBe("2026-05-15");
        expect(grid.cells[5]?.adIso).toBe("2026-05-20");
        expect(grid.cells[30]?.adIso).toBe("2026-06-14");
        expect(grid.cells[5]?.isToday).toBe(true);
        expect(grid.cells[5]?.isSelected).toBe(true);
        expect(grid.leadingBlanks).toBe(5);
      });
    }
  });
});

describe("Node/SSR safety smoke", () => {
  test("imports and converts in the Node test env with no window/DOM dependency", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(bsDayToIso(2086, 9, 1)).toBe("2030-01-15");
  });
});
