import { describe, expect, test } from "vitest";

import { formatKmPerLitre } from "../src/lib/units";

/**
 * Pins `formatKmPerLitre` — the km/L display helper the per-vehicle
 * fuel-efficiency report (Reports v2) renders in its "km/L" column and totals
 * row. The API computes the ratio at the response edge (distanceKm × 1000 /
 * litresMl) as a non-integer and sends `null` when the window is
 * `insufficient-data`; this helper is the single place the web turns that into
 * a two-decimal string or the em-dash. Display-only: distance stays integer km
 * and fuel volume integer mL end-to-end — only this ratio is non-integer, and
 * only at render (CLAUDE.md §"Money & units"; DESIGN.md anti-pattern #14).
 *
 * Rounding cases deliberately avoid the exact `x.xx5` half-boundary: `12.345`
 * is not exactly representable in IEEE-754, so an assertion on it would pin a
 * float artifact rather than the helper's contract. `12.346` / `12.344` sit
 * unambiguously above / below the boundary.
 */
describe("formatKmPerLitre", () => {
  test("renders a finite ratio to exactly two decimals", () => {
    expect(formatKmPerLitre(3.5)).toBe("3.50");
  });

  test("renders a whole number with a two-decimal tail", () => {
    expect(formatKmPerLitre(8)).toBe("8.00");
  });

  test("renders zero as 0.00", () => {
    expect(formatKmPerLitre(0)).toBe("0.00");
  });

  test("rounds up past the second decimal", () => {
    expect(formatKmPerLitre(12.346)).toBe("12.35");
  });

  test("rounds down below the second decimal", () => {
    expect(formatKmPerLitre(12.344)).toBe("12.34");
  });

  test("preserves an exact two-decimal value", () => {
    expect(formatKmPerLitre(7.25)).toBe("7.25");
  });

  test("renders null as the em-dash", () => {
    expect(formatKmPerLitre(null)).toBe("—");
  });

  test("renders undefined as the em-dash", () => {
    expect(formatKmPerLitre(undefined)).toBe("—");
  });

  test("renders a non-finite value as the em-dash", () => {
    expect(formatKmPerLitre(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatKmPerLitre(Number.NaN)).toBe("—");
  });
});
