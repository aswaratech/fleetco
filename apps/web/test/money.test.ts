import { describe, expect, test } from "vitest";

import { paisaToRupeesInput, rupeesToPaisa } from "../src/lib/money";

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
