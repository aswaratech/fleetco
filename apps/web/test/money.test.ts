import { describe, expect, test } from "vitest";

import { formatNpr, paisaToRupeesInput, rupeesToPaisa } from "../src/lib/money";

/**
 * Pins the NPR input converters now homed in `lib/money.ts` (relocated
 * from `lib/fuel-logs-schema.ts` to discharge the tech-debt entry "NPR
 * money converters live in a feature-schema module"). The relocation is
 * a pure move with no behavior change; these are the first tests to pin
 * that behavior, so the "no behavior change" claim is no longer taken on
 * faith.
 *
 * `rupeesToPaisa` (rupees decimal → integer paisa) and
 * `paisaToRupeesInput` (integer paisa → bare rupees decimal string) are
 * the input→storage inverse of `formatNpr`. The wire stores money as
 * integer paisa (CLAUDE.md §"Money & units"); these convert only at the
 * form boundary.
 */
describe("rupeesToPaisa", () => {
  test("converts whole rupees to paisa (×100)", () => {
    expect(rupeesToPaisa(150)).toBe(15000);
  });

  test("rounds half-up at the paisa boundary", () => {
    // 150.005 × 100 lands exactly on 15000.5, which Math.round carries
    // up to 15001 — never truncated down to 15000.
    expect(rupeesToPaisa(150.005)).toBe(15001);
  });

  test("converts zero to zero", () => {
    expect(rupeesToPaisa(0)).toBe(0);
  });
});

describe("paisaToRupeesInput", () => {
  test("renders paisa as a two-decimal rupees string with no glyph or grouping", () => {
    expect(paisaToRupeesInput(15000)).toBe("150.00");
  });

  test("preserves the fractional paisa", () => {
    expect(paisaToRupeesInput(12345)).toBe("123.45");
  });

  test("renders zero as 0.00", () => {
    expect(paisaToRupeesInput(0)).toBe("0.00");
  });
});

describe("round-trip rupees → paisa → rupees string", () => {
  test("whole-rupee value survives the round-trip", () => {
    expect(paisaToRupeesInput(rupeesToPaisa(150))).toBe("150.00");
  });

  test("two-decimal value survives the round-trip", () => {
    expect(paisaToRupeesInput(rupeesToPaisa(123.45))).toBe("123.45");
  });
});

/**
 * Pins `formatNpr` — the single web-side NPR display formatter. Until
 * now it was the one money function with NO test, which is how it drifted
 * to the en-IN currency style ("NPR 0.00"). The FleetCo contract
 * (DESIGN.md §"NPR / paisa display" + anti-pattern #11): `Rs. ` prefix,
 * Nepali lakh grouping, two paisa places, negatives in parentheses.
 * Every example below is one DESIGN.md states verbatim.
 */
describe("formatNpr", () => {
  test("zero renders Rs. 0.00", () => {
    expect(formatNpr(0)).toBe("Rs. 0.00");
  });

  test("one rupee (100 paisa) renders Rs. 1.00", () => {
    expect(formatNpr(100)).toBe("Rs. 1.00");
  });

  test("whole rupees render with two paisa places", () => {
    expect(formatNpr(15000)).toBe("Rs. 150.00");
  });

  test("uses Nepali lakh grouping, not Western thousands", () => {
    // 12550025 paisa = 125500.25 rupees → "1,25,500.25" (lakh), never
    // "125,500.25". The en-IN locale is what gives the lakh grouping.
    expect(formatNpr(12550025)).toBe("Rs. 1,25,500.25");
  });

  test("negative amounts render in parentheses, never with a minus sign", () => {
    const out = formatNpr(-125000);
    expect(out).toBe("(Rs. 1,250.00)");
    expect(out).not.toContain("-");
  });

  test("negative zero renders as plain zero (no parentheses)", () => {
    expect(formatNpr(-0)).toBe("Rs. 0.00");
  });

  test("null / undefined / non-finite render as the em-dash", () => {
    expect(formatNpr(null)).toBe("—");
    expect(formatNpr(undefined)).toBe("—");
    expect(formatNpr(Number.NaN)).toBe("—");
    expect(formatNpr(Number.POSITIVE_INFINITY)).toBe("—");
  });

  test("never emits the INR glyph or the currency code NPR (anti-pattern #11)", () => {
    for (const paisa of [0, 100, 12550025, -125000]) {
      const out = formatNpr(paisa);
      expect(out).not.toContain("₹"); // INR glyph — never in FleetCo
      expect(out).not.toContain("NPR"); // the en-IN currency-style code
    }
  });
});
