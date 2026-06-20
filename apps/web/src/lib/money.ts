// Money formatting for the web. The API stores money as integer paisa
// (CLAUDE.md §"Money & units"); this module is the single place the web
// converts paisa → human-readable NPR string. Centralising the
// formatter keeps the `Rs.` prefix, Nepali lakh grouping, and
// fractional-paisa rounding policy consistent across every page that
// renders money (today: Fuel logs iter 19; future: Expense logs, the
// per-vehicle cost reports).
//
// Round-trip note: this is a display helper. Never go from formatted
// string back to a number — keep paisa integers end-to-end in code,
// only stringify at render. Same discipline the units helper uses for
// liters.

// A PLAIN en-IN number formatter — NOT `{ style: "currency" }`. The
// en-IN locale gives the Nepali lakh grouping ("1,25,500.25", not
// "125,500.25"); the min/max fraction pinning keeps paisa visible even
// when zero. FleetCo always renders the literal "Rs. " prefix by hand
// (DESIGN.md §"NPR / paisa display"; anti-pattern #11): the en-IN
// CURRENCY style would emit "NPR …", and the ₹/₨ glyphs are INR, which
// never appears in this product. The prefix and the parenthesised-
// negative wrap are applied in formatNpr below.
const NPR_NUMBER_FORMATTER = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format an integer paisa value as the FleetCo NPR display string:
 * `Rs. ` + Nepali lakh-grouped rupees + 2-digit paisa, with negatives
 * in parentheses (DESIGN.md §"NPR / paisa display"). Examples:
 *   formatNpr(0)        → "Rs. 0.00"
 *   formatNpr(100)      → "Rs. 1.00"        (100 paisa = 1 rupee)
 *   formatNpr(15000)    → "Rs. 150.00"
 *   formatNpr(12550025) → "Rs. 1,25,500.25" (Nepali lakh grouping)
 *   formatNpr(-125000)  → "(Rs. 1,250.00)"  (negative in parentheses)
 *
 * Null / undefined / non-finite input renders as the em-dash (—) the
 * detail pages use for absent values. The dash keeps tables aligned
 * and is the convention DESIGN.md §"Data display" already documents.
 */
export function formatNpr(paisa: number | null | undefined): string {
  if (paisa === null || paisa === undefined) return "—";
  if (!Number.isFinite(paisa)) return "—";
  // Negatives render in parentheses, never with a leading "-" (DESIGN.md
  // §"NPR / paisa display"). `paisa < 0` is false for -0, so -0 renders
  // "Rs. 0.00", not "(Rs. 0.00)". The 100 divisor stays inside the
  // formatter call so the rupees number is never bound to a variable —
  // keeps the "money is paisa" invariant honest in code review.
  const body = `Rs. ${NPR_NUMBER_FORMATTER.format(Math.abs(paisa) / 100)}`;
  return paisa < 0 ? `(${body})` : body;
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
