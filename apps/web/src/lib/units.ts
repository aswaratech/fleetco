// Unit formatting for the web. The API stores fuel volume as integer
// milliliters (CLAUDE.md §"Money & units" — mechanical extension of
// the money-as-minor-units rule to volume so per-liter prices in paisa
// stay exact integer math). This module is the single place the web
// converts milliliters → human-readable liters string. Centralising
// the formatter keeps the liter glyph, decimal places, and
// fractional-ml rounding policy consistent across every page that
// renders fuel volume (Fuel logs iter 19; the per-vehicle
// fuel-efficiency report, Reports v2).
//
// Round-trip note: this is a display helper. Never go from formatted
// string back to a number — keep milliliters integers end-to-end in
// code, only stringify at render. Same discipline formatNpr uses for
// paisa.

// 3 decimal places: the smallest fill the operator pumps is ~1 L,
// most fills are 20–100 L, and the underlying storage is to the
// milliliter. Three decimals lets a 12.345 L fill render exactly
// without rounding artifacts; the locale formatter handles the
// thousands separator on three-digit liter counts (a 1,000 L tanker
// fill renders as "1,000.000 L").
const LITERS_FORMATTER = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

/**
 * Format an integer milliliter value as a human-readable liter string.
 * Examples:
 *   formatLiters(0)      → "0.000 L"
 *   formatLiters(12345)  → "12.345 L"
 *   formatLiters(150000) → "150.000 L"
 *
 * Null / undefined / non-finite input renders as the em-dash (—) the
 * detail pages use for absent values, matching formatNpr.
 */
export function formatLiters(milliliters: number | null | undefined): string {
  if (milliliters === null || milliliters === undefined) return "—";
  if (!Number.isFinite(milliliters)) return "—";
  // Milliliters → liters as a decimal. The 1000 divisor stays inside
  // the formatter call so the liters number is never bound to a
  // variable anywhere — keeps the "volume is milliliters" invariant
  // honest in code review.
  return `${LITERS_FORMATTER.format(milliliters / 1000)} L`;
}

/**
 * Format an integer kilometer value as a human-readable string.
 * Used for the optional odometer reading on a fuel log. Mirrors the
 * "100,000 km" rendering the Vehicles detail page uses for odometer
 * fields. Null / undefined / non-finite renders as the em-dash.
 */
const KM_FORMATTER = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatKm(km: number | null | undefined): string {
  if (km === null || km === undefined) return "—";
  if (!Number.isFinite(km)) return "—";
  return `${KM_FORMATTER.format(km)} km`;
}

// Engine-hours (ADR-0036). The wire stores engine-hours as integer TENTHS of an
// hour (deci-hours) — never a float, the CLAUDE.md never-floats rule extended to
// a physical quantity via the FuelLog.litersMl precedent. An hour-meter reads to
// 0.1 h, so the operator enters a decimal number of hours (e.g. 1234.5) and the
// wire stores 12345. These three helpers are the single place the web crosses
// that boundary, the sibling of formatKm / litersToMl:
//   - formatHours: display an integer-tenths value as a "1,234.5 h" string.
//   - hoursToTenths: a decimal-hours form value → integer tenths for the wire.
//   - tenthsToHoursInput: an integer-tenths wire value → decimal string for an
//     edit form's pre-fill (no unit suffix — a <input type="number"> rejects it).
// Round-trip note (matches formatNpr / formatLiters): display-only; engine-hours
// stay integer tenths end-to-end in code, only stringified at render.
const HOURS_FORMATTER = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Format an integer tenths-of-an-hour value as a human-readable hours string.
 * Examples:
 *   formatHours(0)     → "0.0 h"
 *   formatHours(600)   → "60.0 h"
 *   formatHours(12345) → "1,234.5 h"
 *
 * Null / undefined / non-finite renders as the em-dash (—), matching formatKm.
 */
export function formatHours(tenths: number | null | undefined): string {
  if (tenths === null || tenths === undefined) return "—";
  if (!Number.isFinite(tenths)) return "—";
  // Tenths → hours inside the formatter call so the hours number is never bound
  // to a variable — keeps the "engine-hours is integer tenths" invariant honest.
  return `${HOURS_FORMATTER.format(tenths / 10)} h`;
}

/**
 * Convert a decimal number of hours (e.g. 1234.5) to the integer tenths the wire
 * stores. Math.round (half-up) mirrors litersToMl / the API's rounding so the
 * stored integer matches what the operator typed. Example: 1234.5 → 12345.
 */
export function hoursToTenths(hours: number): number {
  return Math.round(hours * 10);
}

/**
 * Inverse of hoursToTenths for an edit form's defaultValues — turn the persisted
 * integer tenths back into the one-decimal string the form input accepts.
 * toFixed(1) preserves a trailing zero (12000 → "1200.0"), fine for a number
 * input. Mirrors mlToLitersInput in fuel-logs-schema.ts.
 */
export function tenthsToHoursInput(tenths: number): string {
  return (tenths / 10).toFixed(1);
}

// 2 decimal places: km/L for trucks and tippers sits in the low tens, so two
// decimals is the precision an operator can act on without false significance.
// The "km/L" unit lives in the table column HEADER (DESIGN.md §"Per-vehicle
// fuel-efficiency report"), so the cell carries the bare number — unlike
// formatKm / formatLiters, which label inline. The -tre spelling matches the
// wire field it formats (`kmPerLitre`, mirroring the API's `litresMl`); the
// older American `formatLiters` above predates that field and is left as-is to
// avoid churning a working surface.
const KM_PER_LITRE_FORMATTER = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a km/L efficiency ratio (distance per litre) for display.
 *
 * The API computes this ratio at the response edge as a non-integer and sends
 * `null` when the window holds too little data to trust it (the
 * `insufficient-data` flag) — so this helper renders the em-dash (—) on
 * null / undefined / non-finite input, matching formatNpr / formatLiters /
 * formatKm. A finite value renders to exactly two decimals.
 *
 * Display-only: km/L is never stored. Distance stays integer km and fuel
 * volume stays integer mL end-to-end; only this ratio is non-integer, and only
 * at the render edge. Examples:
 *   formatKmPerLitre(3.5)  → "3.50"
 *   formatKmPerLitre(12.345) → "12.35"   (rounds at the 2nd decimal)
 *   formatKmPerLitre(null) → "—"
 */
export function formatKmPerLitre(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (!Number.isFinite(value)) return "—";
  return KM_PER_LITRE_FORMATTER.format(value);
}
