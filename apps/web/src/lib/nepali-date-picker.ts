// Pure grid + conversion helpers for the Bikram Sambat date-PICKER widget
// (ADR-0032). This is the input twin of `nepali-date.ts` (which owns the BS
// *display* formatter): given a BS year+month it builds the month's day cells,
// maps each cell to its Gregorian (AD) calendar day, locates "today" and the
// selected day, and steps the BS month/year for the popover's arrow controls.
//
// Like `nepali-date.ts`, ALL correctness lives here in pure functions and is
// unit-tested in `test/nepali-date-picker.test.ts`; the React component
// (`components/nepali-date-picker.tsx`) is the thin interactive shell.
//
// REUSE, don't re-derive (ADR-0032 commitment 4): BS↔AD math goes through the
// installed `nepali-date-converter` (the verified source ADR-0031 chose), and
// month names come from the FleetCo-owned `BS_MONTHS` array in `nepali-date.ts`
// (the anti-drift guard — never the library's own locale strings). The
// UTC-calendar-day rule is reused via `formatNepaliDate(iso, { format: "en" })`
// (its `en` shape is exactly the UTC calendar-day "YYYY-MM-DD"), so the rule is
// defined in one place across the formatter, the compliance helper, and now the
// picker.
//
// THE LOAD-BEARING ROUND-TRIP (ADR-0032 commitment 3): a picked BS day must
// emit the SAME ISO/UTC date string the native `<input type="date">` submits,
// timezone-independently. `bsDayToIso` achieves this by reading AD calendar
// integers off the converter (`getAD()`) and formatting them directly — no JS
// `Date` is in the output path, so the result cannot drift by server/local
// timezone. Verified against the library across UTC / America/Chicago /
// Pacific/Kiritimati at build time; pinned by the TZ-independent test.

import NepaliDate from "nepali-date-converter";

import { BS_MONTHS, formatNepaliDate } from "./nepali-date";

// The converter's calendar table spans BS 2000–2090 (≈ AD 1943–2034); it throws
// outside that range. Navigation clamps to these bounds so an arrow control can
// never step the grid into a throwing year.
export const BS_MIN_YEAR = 2000;
export const BS_MAX_YEAR = 2090;

// Sunday-first weekday headers (the converter's `getDay()` returns 0 = Sunday),
// matching the Nepali week. Latin two-letter, consistent with the Latin-only
// numerals/spelling stance of ADR-0031 / ADR-0032 (no Devanagari in v1).
export const WEEKDAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** A BS year + 0-indexed month (0 = Baishakh), the unit the grid navigates. */
export interface BsMonth {
  year: number;
  /** 0-indexed BS month, matching `NepaliDate#getMonth` (0 = Baishakh). */
  month: number;
}

/** One day cell in the month grid (ADR-0032 commitment 2). */
export interface DayCell {
  /** The BS day-of-month (1-based) shown prominently in the cell. */
  bsDay: number;
  /** The Gregorian calendar day "YYYY-MM-DD" — the value selection emits. */
  adIso: string;
  /** True when this cell is the current calendar day. */
  isToday: boolean;
  /** True when this cell matches the picker's current value. */
  isSelected: boolean;
}

/** A fully-built BS month grid ready to render. */
export interface MonthGrid {
  year: number;
  /** 0-indexed BS month. */
  month: number;
  /** FleetCo's spelling of the month (from `BS_MONTHS`, the anti-drift array). */
  monthName: string;
  /** Empty leading cells before day 1 (the weekday index of the 1st, 0 = Su). */
  leadingBlanks: number;
  /** The month's day cells, day 1 → last day. */
  cells: DayCell[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clampYear(year: number): number {
  return Math.min(BS_MAX_YEAR, Math.max(BS_MIN_YEAR, year));
}

/**
 * Normalize any ISO/timestamp to its UTC calendar day "YYYY-MM-DD", or null for
 * absent/unparseable input. Reuses `formatNepaliDate`'s `en` shape so the
 * UTC-calendar-day rule has exactly one definition (its em-dash sentinel for
 * absent input maps back to null here).
 */
export function isoToUtcDay(iso: string | null | undefined): string | null {
  const en = formatNepaliDate(iso, { format: "en" });
  return en === "—" ? null : en;
}

/**
 * Map a BS day (year, 0-indexed month, day) to its Gregorian calendar day
 * "YYYY-MM-DD" — the load-bearing selection mapping (ADR-0032 commitment 3).
 *
 * `getAD()` returns AD calendar integers, so the formatted result is
 * timezone-independent (no JS `Date` in the path) and round-trips to the exact
 * string a native `<input type="date">` would submit. It is the inverse of the
 * AD→BS conversion `formatNepaliDate` performs for display.
 */
export function bsDayToIso(bsYear: number, bsMonth: number, bsDay: number): string {
  const ad = new NepaliDate(bsYear, bsMonth, bsDay).getAD();
  return `${ad.year}-${pad2(ad.month + 1)}-${pad2(ad.date)}`;
}

/**
 * The BS month (year + 0-indexed month) an ISO/UTC date falls in, or null for
 * absent/unparseable/out-of-range input. Mirrors `formatNepaliDate`'s AD→BS
 * discipline: build a LOCAL `Date` from the UTC components and hand it to the
 * converter (which reads a `Date` via local getters), so the BS month is the
 * one the UTC calendar day belongs to regardless of server timezone.
 */
export function isoToBsMonth(iso: string | null | undefined): BsMonth | null {
  const day = isoToUtcDay(iso);
  if (day === null) return null;
  const parts = day.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  try {
    const bs = new NepaliDate(new Date(y, m - 1, d)).getBS();
    return { year: bs.year, month: bs.month };
  } catch {
    return null;
  }
}

/**
 * The number of days (29–32) in a BS month. Probes the converter day by day:
 * it normalizes an out-of-month day into the next month (so `getMonth()` stops
 * matching) and throws past the table edge (caught) — making this robust at
 * both ends of the calendar table with no special case.
 */
export function bsMonthLength(bsYear: number, bsMonth: number): number {
  let length = 0;
  for (let day = 1; day <= 32; day++) {
    try {
      const probe = new NepaliDate(bsYear, bsMonth, day);
      if (probe.getMonth() === bsMonth && probe.getYear() === bsYear) length = day;
      else break;
    } catch {
      break;
    }
  }
  return length;
}

/**
 * Build the renderable grid for a BS month, marking the cell that is "today"
 * and the cell that matches the picker's current value. `todayIso` and
 * `selectedIso` are normalized to their UTC calendar day before comparison, so
 * day-of selection and today-highlighting are timezone-independent.
 */
export function buildMonthGrid(
  month: BsMonth,
  opts?: { todayIso?: string | null; selectedIso?: string | null },
): MonthGrid {
  const { year, month: m } = month;
  const today = isoToUtcDay(opts?.todayIso);
  const selected = isoToUtcDay(opts?.selectedIso);
  const leadingBlanks = new NepaliDate(year, m, 1).getDay();
  const length = bsMonthLength(year, m);

  const cells: DayCell[] = [];
  for (let day = 1; day <= length; day++) {
    const adIso = bsDayToIso(year, m, day);
    cells.push({
      bsDay: day,
      adIso,
      isToday: adIso === today,
      isSelected: adIso === selected,
    });
  }

  return { year, month: m, monthName: BS_MONTHS[m], leadingBlanks, cells };
}

/**
 * Step the BS month by `delta` (±1 for the popover's month arrows), carrying
 * across the Chaitra→Baishakh year boundary, clamped to the converter's table
 * range so navigation can never throw.
 */
export function stepBsMonth(month: BsMonth, delta: number): BsMonth {
  const total = month.year * 12 + month.month + delta;
  const year = Math.floor(total / 12);
  const m = total - year * 12; // 0..11 (total ≥ 0 for in-range years)
  if (year < BS_MIN_YEAR) return { year: BS_MIN_YEAR, month: 0 };
  if (year > BS_MAX_YEAR) return { year: BS_MAX_YEAR, month: 11 };
  return { year, month: m };
}

/** Step the BS year by `delta` (±1 for the year arrows), keeping the month. */
export function stepBsYear(month: BsMonth, delta: number): BsMonth {
  return { year: clampYear(month.year + delta), month: month.month };
}

/**
 * The BS month the picker opens to: the selected value's month if set,
 * otherwise today's month. Both are clamped into the table range.
 */
export function initialBsMonth(opts: { selectedIso?: string | null; todayIso: string }): BsMonth {
  const fromSelected = isoToBsMonth(opts.selectedIso);
  if (fromSelected) return clampMonth(fromSelected);
  const fromToday = isoToBsMonth(opts.todayIso);
  if (fromToday) return clampMonth(fromToday);
  return { year: BS_MAX_YEAR, month: 0 };
}

function clampMonth(month: BsMonth): BsMonth {
  return { year: clampYear(month.year), month: Math.min(11, Math.max(0, month.month)) };
}
