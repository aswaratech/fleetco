// Bikram Sambat (BS) date formatting, hosted in @fleetco/shared so BOTH apps
// consume ONE copy (ADR-0038 commitment 6). FleetCo stores dates as ISO/UTC in
// Postgres (CLAUDE.md), and renders Bikram Sambat for the Nepali operator
// "where appropriate" (CLAUDE.md §dates). This module is the single place the
// system converts an ISO date string → a BS-prominent human string: the web
// uses it everywhere a date is shown, and the notification scan (apps/api,
// Program C / ADR-0038 commitment 7) uses it to render the reminder digest in
// the operator's calendar. Centralising the formatter keeps the BS month
// spelling, the Gregorian parenthetical, and the UTC-calendar-day rule
// consistent across every surface that shows a date — so the convention can
// never drift surface-to-surface again (ADR-0031; DESIGN.md §"BS calendar").
// apps/web re-exports these symbols from its own `lib/nepali-date.ts` so its
// existing `@/lib/nepali-date` importers are unchanged.
//
// Round-trip note: this is a display helper. Dates stay ISO/UTC strings
// end-to-end in code; BS is a render-time conversion only — never stored,
// never round-tripped through the API as the canonical form (DESIGN.md
// anti-pattern #12). Same discipline `formatNpr` uses for paisa.

import NepaliDate from "nepali-date-converter";

/**
 * The 12 Bikram Sambat month names in order (index 0 = Baishakh), in Latin
 * transliteration (no Devanagari numerals/script in v1 — DESIGN.md
 * §Devanagari). This array is FleetCo's source of truth for BS month
 * spelling (ADR-0031 commitment 2), NOT the conversion library's own locale
 * strings — so a library update can never silently change a rendered month
 * name. It is the same anti-drift discipline applied between the pino
 * redact/scrub lists and between Tailwind and DESIGN.md: own the value that
 * matters, don't read it from a dependency that may shift it.
 *
 * Verified at install (nepali-date-converter@3.4.0): the library's own
 * English long-names differ from this array at three indices — lib
 * "Baisakh"→"Baishakh" (0), "Asar"→"Ashadh" (2), "Aswin"→"Ashwin" (5); the
 * other nine match. We render month names from THIS array (indexed by the
 * library's numeric BS month), so those three always render with FleetCo's
 * chosen spelling regardless of the library.
 */
export const BS_MONTHS = [
  "Baishakh",
  "Jestha",
  "Ashadh",
  "Shrawan",
  "Bhadra",
  "Ashwin",
  "Kartik",
  "Mangsir",
  "Poush",
  "Magh",
  "Falgun",
  "Chaitra",
] as const;

/** Display variants for {@link formatNepaliDate} (DESIGN.md §Data display). */
export type NepaliDateFormat = "both" | "bs" | "en";

interface UtcDayParts {
  y: number;
  /** 0-indexed month, matching `Date#getUTCMonth`. */
  m: number;
  d: number;
}

// Extract the UTC calendar-day components from an ISO string, or null when
// the input is absent / unparseable. This reads the same
// `getUTCFullYear/getUTCMonth/getUTCDate` the per-page inline `formatDate`
// copies used, so the BS render lands on the SAME calendar day the Gregorian
// render shows — independent of the server's timezone.
function utcDayParts(iso: string | null | undefined): UtcDayParts | null {
  if (iso === null || iso === undefined) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

// Render the Gregorian "YYYY-MM-DD" string from UTC day parts — byte-for-byte
// what the old inline `formatDate` produced. This is the `en` variant and the
// safe degrade.
function toGregorian({ y, m, d }: UtcDayParts): string {
  const mm = String(m + 1).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Convert UTC day parts to the BS string "<year> <Month> <day>", or null when
// the date falls outside the library's calendar table (it throws past
// ~AD 2034 / BS 2090) so callers can degrade to Gregorian.
//
// THE UTC-CALENDAR-DAY RULE (ADR-0031 commitment 3 — load-bearing):
// nepali-date-converter@3.4.0 reads a JS Date through its SERVER-LOCAL
// getters (getFullYear/getMonth/getDate), NOT its absolute UTC instant. So
// the Date we hand it must have LOCAL components equal to the UTC calendar
// day: `new Date(y, m, d)` (local midnight of that day). We deliberately do
// NOT use `new Date(Date.UTC(y, m, d))` — that is a midnight-UTC *instant*
// which, read with local getters on a server west of UTC (e.g.
// America/Chicago), rolls back to the PREVIOUS day and renders the BS date
// one day early. Verified at install across UTC, Asia/Kathmandu,
// America/Chicago, America/Anchorage, Pacific/Kiritimati, Pacific/Apia and
// Europe/London: `new Date(y, m, d)` is identical in all seven; the
// `Date.UTC(...)` form diverges in the western zones. The ADR's commitment-3
// GOAL is "convert the SAME UTC calendar day … or a deadline renders one BS
// day early/late depending on server timezone"; `new Date(y, m, d)` is what
// achieves that goal for this library (the ADR's "e.g. Date.UTC(...)"
// illustration assumed an instant-based converter). The TZ-independent test
// in apps/web/test/nepali-date.test.ts pins this — it fails with the
// `Date.UTC` form.
function toBikramSambat({ y, m, d }: UtcDayParts): string | null {
  try {
    const bs = new NepaliDate(new Date(y, m, d)).getBS();
    const monthName = BS_MONTHS[bs.month];
    if (monthName === undefined) return null; // defensive: month index out of 0–11
    return `${bs.year} ${monthName} ${bs.date}`;
  } catch {
    // Outside the library's BS 2000–2090 table range. Let the caller degrade
    // to Gregorian — ADR-0031: "en … the safe degrade if conversion ever
    // throws." Compliance expiries are near-future and stay well in range.
    return null;
  }
}

/**
 * Format an ISO/UTC date string for the Nepali operator.
 *
 * Variants (DESIGN.md §Data display; default `both`):
 *   formatNepaliDate("2026-05-20T00:00:00Z")                    → "2083 Jestha 6 (2026-05-20)"
 *   formatNepaliDate("2026-05-20T00:00:00Z", { format: "bs" })  → "2083 Jestha 6"
 *   formatNepaliDate("2026-05-20T00:00:00Z", { format: "en" })  → "2026-05-20"
 *
 * The BS values come from the verified conversion library, never fabricated
 * (DESIGN.md anti-pattern #12). Note: DESIGN.md's illustration writes
 * "2082 Jestha 6" for 2026-05-20, but the library — the verified source —
 * converts it to 2083 Jestha 6 (BS 2083 Baishakh 1 ≈ 2026-04-14, so Jestha 6
 * = 2026-05-20). Per ADR-0031 we trust the library for the VALUES and
 * DESIGN.md for the SHAPE.
 *
 * Null / undefined / unparseable input renders as the em-dash (—) the detail
 * pages use for absent values, identical to {@link formatNpr}. A date outside
 * the library's calendar table degrades to the Gregorian "YYYY-MM-DD" (the
 * `en` shape) rather than throwing.
 */
export function formatNepaliDate(
  iso: string | null | undefined,
  opts?: { format?: NepaliDateFormat },
): string {
  const parts = utcDayParts(iso);
  if (parts === null) return "—";

  const en = toGregorian(parts);
  const format = opts?.format ?? "both";
  if (format === "en") return en;

  const bs = toBikramSambat(parts);
  if (bs === null) return en; // safe degrade for an out-of-table date
  if (format === "bs") return bs;
  return `${bs} (${en})`;
}

/** The Bikram Sambat fiscal year an ISO/UTC date falls in (see {@link bsFiscalYear}). */
export interface BsFiscalYear {
  /** The BS year the fiscal year STARTS in — the year of its Shrawan 1. */
  startYear: number;
  /** The BS year the fiscal year ENDS in (`startYear + 1`) — the year of its
   * Ashadh end. */
  endYear: number;
  /** `"<startYear>-<endYear mod 100>"`, e.g. `"2082-83"` — the fiscal-year token
   * embedded in the invoice number and used as the per-series counter key. */
  label: string;
}

// The fiscal year begins at Shrawan, which is index 3 in BS_MONTHS
// (Baishakh 0, Jestha 1, Ashadh 2, Shrawan 3). Months Shrawan(3)..Chaitra(11)
// belong to the fiscal year that starts in the SAME BS calendar year;
// Baishakh(0)..Ashadh(2) belong to the one that started the PREVIOUS Shrawan.
const FISCAL_YEAR_START_MONTH = 3;

/**
 * The Bikram Sambat fiscal year an ISO/UTC date falls in. The Nepali fiscal
 * year runs Shrawan 1 → Ashadh end (roughly mid-July to mid-July; see the
 * glossary), so a date's fiscal year is NOT simply its BS calendar year: a date
 * in Baishakh / Jestha / Ashadh belongs to the fiscal year that STARTED the
 * previous Shrawan.
 *
 * Used by the invoice numbering (ADR-0039 commitment 4): the gapless invoice
 * number is scoped to this fiscal year (e.g. `INV-2082-83-00001`), and the
 * per-series counter is keyed by its `label`. Hosted HERE (not in apps/api) so
 * the `nepali-date-converter` stays wrapped in ONE place (the wrap-the-vendor
 * discipline, ADR-0031) — the API reaches the BS calendar only through
 * `@fleetco/shared`, never the library directly.
 *
 * Worked boundary (verified against the converter): 2025-07-16 → BS 2082 Ashadh
 * 32 → FY `2081-82` (the last day of that FY); 2025-07-17 → BS 2082 Shrawan 1 →
 * FY `2082-83` (the first day of the next FY).
 *
 * Returns `null` when the input is absent / unparseable or falls outside the
 * converter's BS table range (it throws past ~AD 2034 / BS 2090) — mirroring
 * {@link formatNepaliDate}'s safe-degrade contract. The caller decides how to
 * handle an out-of-range date (the invoice issue flow surfaces a clear error
 * rather than fabricating a number).
 */
export function bsFiscalYear(iso: string | null | undefined): BsFiscalYear | null {
  const parts = utcDayParts(iso);
  if (parts === null) return null;

  let bsYear: number;
  let bsMonth: number;
  try {
    // Same UTC-calendar-day construction as toBikramSambat (the load-bearing
    // rule documented there): build a Date from the ISO's UTC day components so
    // the BS day is server-timezone-independent.
    const bs = new NepaliDate(new Date(parts.y, parts.m, parts.d)).getBS();
    bsYear = bs.year;
    bsMonth = bs.month;
  } catch {
    return null; // outside the library's BS 2000–2090 table range
  }

  const startYear = bsMonth >= FISCAL_YEAR_START_MONTH ? bsYear : bsYear - 1;
  const endYear = startYear + 1;
  const label = `${startYear}-${String(endYear).slice(-2)}`;
  return { startYear, endYear, label };
}
