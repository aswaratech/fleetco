import { describe, expect, test } from "vitest";

import { formatHours, formatKmPerLitre, hoursToTenths, tenthsToHoursInput } from "../src/lib/units";

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

/**
 * Pins the engine-hours helpers (ADR-0036). Engine-hours are stored as integer
 * TENTHS of an hour (deci-hours) — the FuelLog.litersMl integer-minor-units
 * precedent — so the web crosses the decimal↔integer boundary at the form edge
 * (hoursToTenths / tenthsToHoursInput) and at render (formatHours). These three
 * are the only place that conversion happens; pinning them keeps the wire
 * integer matching what the operator typed and the display matching the wire.
 */
describe("formatHours", () => {
  test("renders integer tenths as a one-decimal hours string", () => {
    expect(formatHours(600)).toBe("60.0 h");
  });

  test("renders zero as 0.0 h", () => {
    expect(formatHours(0)).toBe("0.0 h");
  });

  test("renders a fractional tenth (the hour-meter's native resolution)", () => {
    expect(formatHours(12345)).toBe("1,234.5 h");
  });

  test("renders null / undefined / non-finite as the em-dash", () => {
    expect(formatHours(null)).toBe("—");
    expect(formatHours(undefined)).toBe("—");
    expect(formatHours(Number.NaN)).toBe("—");
    expect(formatHours(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("hoursToTenths / tenthsToHoursInput round-trip", () => {
  test("hoursToTenths converts a decimal-hours value to integer tenths (half-up)", () => {
    expect(hoursToTenths(1234.5)).toBe(12345);
    expect(hoursToTenths(60)).toBe(600);
    expect(hoursToTenths(0)).toBe(0);
  });

  test("tenthsToHoursInput converts integer tenths back to a one-decimal string", () => {
    expect(tenthsToHoursInput(12345)).toBe("1234.5");
    expect(tenthsToHoursInput(12000)).toBe("1200.0");
    expect(tenthsToHoursInput(0)).toBe("0.0");
  });

  test("a value round-trips through tenths and back to the same hours", () => {
    // The edit-form pre-fill (tenths → string) and submit (string → tenths)
    // must compose to the identity so an untouched hours field is a no-op diff.
    const tenths = 12345;
    expect(hoursToTenths(Number(tenthsToHoursInput(tenths)))).toBe(tenths);
  });
});
