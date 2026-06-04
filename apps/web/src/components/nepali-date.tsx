import { formatNepaliDate, type NepaliDateFormat } from "@/lib/nepali-date";

// <NepaliDate> — the markup wrapper over the pure `formatNepaliDate`
// formatter, following DESIGN.md's documented prop shape
// `<NepaliDate iso="2026-05-20" format="bs|en|both" />` (consistent with the
// documented `<Money paisa={…} />`). It is to `formatNepaliDate` what
// `<Money>` is to `formatNpr` — a thin presentation wrapper over a pure
// function. ADR-0031 commitment 3.
//
// This is a SERVER component (no "use client"): the BS conversion runs in
// Node during SSR, so the calendar table never ships to the browser. All
// correctness lives in the pure formatter and is exercised in
// `test/nepali-date.test.ts`; the component is markup only, and ships
// untested-by-render exactly as the money/units formatters' callers do (no
// render-test harness exists — vitest collects only `test/**/*.test.ts` with
// no jsdom).

interface NepaliDateProps {
  /** The stored ISO/UTC date. Null / undefined / unparseable → em-dash. */
  iso: string | null | undefined;
  /** DESIGN.md §Data display variant; default `both`. */
  format?: NepaliDateFormat;
}

export function NepaliDate({ iso, format = "both" }: NepaliDateProps): React.ReactElement {
  // `en` is a plain Gregorian string — render it (or the em-dash) as-is.
  if (format === "en") {
    return <>{formatNepaliDate(iso, { format: "en" })}</>;
  }

  const bs = formatNepaliDate(iso, { format: "bs" });
  // Absent / unparseable input collapses to a single em-dash — never the
  // "— (—)" a naive `both` composition would produce.
  if (bs === "—") {
    return <>—</>;
  }

  const en = formatNepaliDate(iso, { format: "en" });

  if (format === "bs") {
    // BS only, with the Gregorian date recoverable in a hover tooltip so it
    // stays available in dense table cells without spending column width.
    return <span title={en}>{bs}</span>;
  }

  // both (default): BS prominent, Gregorian parenthetical muted — DESIGN.md
  // §"BS calendar": "Gregorian parenthetical in color.text.muted".
  return (
    <>
      {bs} <span className="text-text-muted">({en})</span>
    </>
  );
}
