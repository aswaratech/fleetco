// Money formatting for the web. The API stores money as integer paisa
// (CLAUDE.md §"Money & units"); this module is the single place the web
// converts paisa → human-readable NPR string. Centralising the
// formatter keeps the rupee glyph, thousands separator, and
// fractional-paisa rounding policy consistent across every page that
// renders money (today: Fuel logs iter 19; future: Expense logs, the
// per-vehicle cost reports).
//
// Round-trip note: this is a display helper. Never go from formatted
// string back to a number — keep paisa integers end-to-end in code,
// only stringify at render. Same discipline the units helper uses for
// liters.

const NPR_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "NPR",
  // NPR has 2-paisa-place subunits; the en-IN locale renders the rupee
  // glyph and an Indian-grouping thousands separator (lakh / crore),
  // which is the convention the operator base reads day-to-day. The
  // CURRENCY style emits "NPR 1,234.56" by default in the Node ICU
  // build; if a future iter wants the ₨ glyph we'll switch to a manual
  // template.
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format an integer paisa value as a human-readable NPR string.
 * Examples:
 *   formatNpr(0)        → "NPR 0.00"
 *   formatNpr(15000)    → "NPR 150.00"   (15000 paisa = 150 rupees)
 *   formatNpr(12345678) → "NPR 1,23,456.78"  (Indian grouping)
 *
 * Null / undefined / non-finite input renders as the em-dash (—) the
 * detail pages use for absent values. The dash keeps tables aligned
 * and is the convention DESIGN.md §"Data display" already documents.
 */
export function formatNpr(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return "—";
  if (!Number.isFinite(paisa)) return "—";
  // Paisa → rupees as a decimal. The 100 divisor stays inside the
  // formatter call so the rupees number is never bound to a variable
  // anywhere — keeps the "money is paisa" invariant honest in code
  // review.
  return NPR_FORMATTER.format(paisa / 100);
}

// ---------------------------------------------------------------------
// Input converters — the inverse direction of `formatNpr`. Where
// `formatNpr` renders stored integer paisa for display, these turn the
// operator-typed rupees decimal at a form boundary into the integer
// paisa the API stores (and back into the bare decimal string an
// `<input type="number">` accepts). They are generic NPR money logic —
// not specific to any one feature — which is why they live here next to
// `formatNpr` rather than in a feature-schema module.
//
// Same round-trip discipline as `formatNpr`: paisa stay integers
// end-to-end in code; the rupees decimal exists only at the form edge.
// ---------------------------------------------------------------------

/**
 * Convert an operator-typed rupees decimal into integer paisa for the
 * wire. The input→storage inverse of {@link formatNpr}.
 *
 * Rounds half-up (`Math.round`) at the paisa boundary so a value the
 * operator can legitimately type is never truncated; the API applies
 * the same half-up rule, so a client-side preview matches the persisted
 * value bit-for-bit. Examples:
 *   rupeesToPaisa(150)     → 15000   (150 NPR = 15000 paisa)
 *   rupeesToPaisa(150.005) → 15001   (half-up at the paisa boundary)
 */
export function rupeesToPaisa(rupees: number): number {
  return Math.round(rupees * 100);
}

/**
 * Render an integer paisa value as the plain rupees decimal string an
 * `<input type="number">` accepts (e.g. an edit form's defaultValues).
 *
 * Unlike {@link formatNpr}, this emits NO currency glyph and NO locale
 * grouping — a numeric input rejects both. Two decimal places, since
 * NPR has paisa-subunits. Examples:
 *   paisaToRupeesInput(15000) → "150.00"
 *   paisaToRupeesInput(12345) → "123.45"
 */
export function paisaToRupeesInput(paisa: number): string {
  return (paisa / 100).toFixed(2);
}
