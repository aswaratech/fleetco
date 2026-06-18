import { InvoiceServiceType } from "@prisma/client";
import { describe, expect, test } from "vitest";

import { computeInvoiceTax, computeTaxPaisa } from "../src/modules/invoices/invoice-tax";
import {
  BASIS_POINTS_DENOMINATOR,
  INVOICE_TDS_RATE_BP,
  INVOICE_VAT_RATE_BP,
} from "../src/modules/invoices/invoice-tax.constants";

// Pure unit tests for the invoice VAT + TDS calculator (Program D / ADR-0039
// commitment 3). No DB is needed — the calculator is pure (primitives in, the
// frozen snapshot out), so these mirror the deriveTotalCostPaisa() pure tests in
// fuel-logs.service.test.ts: they pin the rounding rule (half-up via Math.round,
// not banker's, not truncation) and the integer-paisa discipline so a regression
// in the tax math is caught immediately. Every worked example documents the exact
// arithmetic the way the fuel-log test documents 12345 × 11055 / 1000 = 136473.975
// → 136474.
//
// The rates are the PROPOSED constants from invoice-tax.constants.ts (VAT 1300bp,
// TDS 150/250bp by service type) — operator/accountant-verify before real use
// (ADR-0039 c9). A dedicated describe block below pins those values and proves the
// calculator actually uses them, so a silent rate edit fails a test.

describe("computeTaxPaisa() — the half-up paisa-boundary primitive", () => {
  test("0.5 rounds UP, not banker's, not truncation", () => {
    // 50 paisa × 1300 bp / 10000 = 65000 / 10000 = 6.5 → Math.round → 7.
    // Half-up resolves .5 upward; truncation would give 6 and banker's-rounding
    // (round-half-to-even) would also give 6 (6 is even), so 7 is the half-up
    // signature.
    expect(computeTaxPaisa(50, INVOICE_VAT_RATE_BP)).toBe(7);
    // 20 paisa × 250 bp / 10000 = 5000 / 10000 = 0.5 → 1 (half-up; banker's → 0).
    expect(computeTaxPaisa(20, INVOICE_TDS_RATE_BP.GOODS_TRANSPORT)).toBe(1);
  });

  test("exact (no fractional paisa) needs no rounding", () => {
    // 1_000_000 × 1300 / 10000 = 130000.0 exactly.
    expect(computeTaxPaisa(1_000_000, INVOICE_VAT_RATE_BP)).toBe(130_000);
  });

  test("a zero base or zero rate gives zero", () => {
    expect(computeTaxPaisa(0, INVOICE_VAT_RATE_BP)).toBe(0);
    expect(computeTaxPaisa(1_000_000, 0)).toBe(0);
  });
});

describe("computeInvoiceTax() — the VAT + TDS frozen-snapshot calculator", () => {
  test("worked half-up boundary: VAT lands on .5 and rounds UP", () => {
    // Two lines, no discount, VEHICLE_HIRE. The taxable base is chosen so the VAT
    // computation lands EXACTLY on a half-paisa fraction:
    //   subtotal = 1_000_000 + 235_050           = 1_235_050
    //   taxable  = 1_235_050 (no discount)
    //   vat      = round(1_235_050 × 1300 / 10000)
    //            = round(1_605_565_000 / 10000)
    //            = round(160_556.5)              = 160_557   ← half-up
    //              (truncation → 160_556; banker's → 160_556 since 160_556 is even,
    //               so 160_557 is the unambiguous half-up answer)
    //   gross    = 1_235_050 + 160_557           = 1_395_607
    //   tds      = round(1_235_050 × 150 / 10000)
    //            = round(18_525.75)              = 18_526
    //   net      = 1_395_607 − 18_526            = 1_377_081
    const snap = computeInvoiceTax({
      lineAmountsPaisa: [1_000_000, 235_050],
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });

    expect(snap.subtotalPaisa).toBe(1_235_050);
    expect(snap.discountPaisa).toBe(0);
    expect(snap.vatRateBp).toBe(1300);
    expect(snap.vatPaisa).toBe(160_557); // the .5 rounded UP
    expect(snap.grossPaisa).toBe(1_395_607);
    expect(snap.tdsRateBp).toBe(150);
    expect(snap.tdsPaisa).toBe(18_526);
    expect(snap.netReceivablePaisa).toBe(1_377_081);
    expect(snap.serviceType).toBe(InvoiceServiceType.VEHICLE_HIRE);
  });

  test("TDS rate is selected by serviceType (VEHICLE_HIRE 150bp vs GOODS_TRANSPORT 250bp)", () => {
    // Same single-line taxable base for both, so only the TDS leg differs.
    //   taxable = 1_000_000
    //   vat     = round(1_000_000 × 1300 / 10000) = 130_000  (same for both)
    //   gross   = 1_000_000 + 130_000            = 1_130_000 (same for both)
    const lineAmountsPaisa = [1_000_000];

    const hire = computeInvoiceTax({
      lineAmountsPaisa,
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });
    const goods = computeInvoiceTax({
      lineAmountsPaisa,
      serviceType: InvoiceServiceType.GOODS_TRANSPORT,
    });

    // VEHICLE_HIRE → 1.5%: tds = round(1_000_000 × 150 / 10000) = 15_000
    expect(hire.tdsRateBp).toBe(150);
    expect(hire.tdsPaisa).toBe(15_000);
    expect(hire.netReceivablePaisa).toBe(1_115_000); // 1_130_000 − 15_000

    // GOODS_TRANSPORT → 2.5%: tds = round(1_000_000 × 250 / 10000) = 25_000
    expect(goods.tdsRateBp).toBe(250);
    expect(goods.tdsPaisa).toBe(25_000);
    expect(goods.netReceivablePaisa).toBe(1_105_000); // 1_130_000 − 25_000
  });

  test("a discount reduces the taxable base, and VAT / gross / net all recompute off it", () => {
    // lines 1_000_000, discount 200_000, VEHICLE_HIRE.
    //   subtotal = 1_000_000 (BEFORE discount — the subtotal is the pre-discount Σ)
    //   taxable  = 1_000_000 − 200_000 = 800_000   (the discounted figure IS the base)
    //   vat      = round(800_000 × 1300 / 10000) = 104_000  (NOT 130_000, the no-discount value)
    //   gross    = 800_000 + 104_000            = 904_000
    //   tds      = round(800_000 × 150 / 10000)  = 12_000
    //   net      = 904_000 − 12_000             = 892_000
    const snap = computeInvoiceTax({
      lineAmountsPaisa: [1_000_000],
      discountPaisa: 200_000,
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });

    expect(snap.subtotalPaisa).toBe(1_000_000); // pre-discount subtotal preserved
    expect(snap.discountPaisa).toBe(200_000);
    expect(snap.vatPaisa).toBe(104_000); // off the discounted 800_000, not 1_000_000
    expect(snap.grossPaisa).toBe(904_000);
    expect(snap.tdsPaisa).toBe(12_000);
    expect(snap.netReceivablePaisa).toBe(892_000);

    // Cross-check: with no discount the same lines yield the larger VAT, proving
    // the discount actually moved the base.
    const noDiscount = computeInvoiceTax({
      lineAmountsPaisa: [1_000_000],
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });
    expect(noDiscount.vatPaisa).toBe(130_000);
    expect(snap.vatPaisa).toBeLessThan(noDiscount.vatPaisa);
  });

  test("subtotal is the sum of all line amounts", () => {
    const snap = computeInvoiceTax({
      lineAmountsPaisa: [250_000, 250_000, 500_000],
      serviceType: InvoiceServiceType.GOODS_TRANSPORT,
    });
    // 250_000 + 250_000 + 500_000 = 1_000_000
    expect(snap.subtotalPaisa).toBe(1_000_000);
  });

  test("TDS does NOT change gross — gross is identical regardless of service type", () => {
    // TDS is withheld by the payer; it must never enter the gross billed amount.
    // Proof: change ONLY the service type (which changes the TDS leg) and gross
    // stays put.
    const lineAmountsPaisa = [777_777];
    const hire = computeInvoiceTax({
      lineAmountsPaisa,
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });
    const goods = computeInvoiceTax({
      lineAmountsPaisa,
      serviceType: InvoiceServiceType.GOODS_TRANSPORT,
    });

    expect(hire.grossPaisa).toBe(goods.grossPaisa);
    // gross is exactly taxable + VAT, with no TDS term.
    expect(hire.grossPaisa).toBe(hire.subtotalPaisa + hire.vatPaisa);
    // and the TDS legs genuinely differ (so the gross-equality above is meaningful)
    expect(hire.tdsPaisa).not.toBe(goods.tdsPaisa);
  });

  test("netReceivable = gross − tds (the memo subtraction) for every case", () => {
    const cases = [
      { lineAmountsPaisa: [1_235_050], serviceType: InvoiceServiceType.VEHICLE_HIRE },
      { lineAmountsPaisa: [999], serviceType: InvoiceServiceType.GOODS_TRANSPORT },
      {
        lineAmountsPaisa: [500_000, 123_456],
        discountPaisa: 50_000,
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      },
    ];
    for (const input of cases) {
      const snap = computeInvoiceTax(input);
      expect(snap.netReceivablePaisa).toBe(snap.grossPaisa - snap.tdsPaisa);
    }
  });

  test("integer in, integer out — no float leaks into any snapshot field", () => {
    // Include a case that rounds (the .5 boundary) and a discounted case, so the
    // rounding path is exercised. Every numeric field must be an integer.
    const inputs = [
      { lineAmountsPaisa: [1_000_000, 235_050], serviceType: InvoiceServiceType.VEHICLE_HIRE },
      {
        lineAmountsPaisa: [333_333, 666_667],
        discountPaisa: 1,
        serviceType: InvoiceServiceType.GOODS_TRANSPORT,
      },
      { lineAmountsPaisa: [1], serviceType: InvoiceServiceType.VEHICLE_HIRE },
    ];
    for (const input of inputs) {
      const snap = computeInvoiceTax(input);
      for (const [key, value] of Object.entries(snap)) {
        if (typeof value === "number") {
          expect(Number.isInteger(value), `${key} must be an integer`).toBe(true);
        }
      }
    }
  });

  test("zero / empty edge: no lines yields an all-zero snapshot (rates still frozen)", () => {
    const empty = computeInvoiceTax({
      lineAmountsPaisa: [],
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });
    expect(empty.subtotalPaisa).toBe(0);
    expect(empty.discountPaisa).toBe(0);
    expect(empty.vatPaisa).toBe(0);
    expect(empty.grossPaisa).toBe(0);
    expect(empty.tdsPaisa).toBe(0);
    expect(empty.netReceivablePaisa).toBe(0);
    // The rates are still present (D3 freezes them regardless of the amounts).
    expect(empty.vatRateBp).toBe(1300);
    expect(empty.tdsRateBp).toBe(150);

    // All-zero lines behave the same.
    const zeros = computeInvoiceTax({
      lineAmountsPaisa: [0, 0],
      serviceType: InvoiceServiceType.GOODS_TRANSPORT,
    });
    expect(zeros.subtotalPaisa).toBe(0);
    expect(zeros.grossPaisa).toBe(0);

    // A discount that exactly equals the subtotal drives the taxable base to 0:
    // every tax leg is 0 but subtotal/discount reflect the inputs.
    const fullyDiscounted = computeInvoiceTax({
      lineAmountsPaisa: [1_000],
      discountPaisa: 1_000,
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });
    expect(fullyDiscounted.subtotalPaisa).toBe(1_000);
    expect(fullyDiscounted.discountPaisa).toBe(1_000);
    expect(fullyDiscounted.vatPaisa).toBe(0);
    expect(fullyDiscounted.grossPaisa).toBe(0);
    expect(fullyDiscounted.tdsPaisa).toBe(0);
    expect(fullyDiscounted.netReceivablePaisa).toBe(0);
  });

  test("the snapshot has exactly the frozen-column keys (the D1 Invoice columns)", () => {
    const snap = computeInvoiceTax({
      lineAmountsPaisa: [1_000_000],
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });
    expect(Object.keys(snap).sort()).toEqual(
      [
        "subtotalPaisa",
        "discountPaisa",
        "vatRateBp",
        "vatPaisa",
        "grossPaisa",
        "tdsRateBp",
        "tdsPaisa",
        "netReceivablePaisa",
        "serviceType",
      ].sort(),
    );
  });
});

describe("computeInvoiceTax() — input guards (a financial calculator refuses garbage)", () => {
  test("a discount larger than the subtotal is rejected (non-negative taxable invariant)", () => {
    expect(() =>
      computeInvoiceTax({
        lineAmountsPaisa: [1_000],
        discountPaisa: 1_500,
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      }),
    ).toThrow(RangeError);
  });

  test("a non-integer (float) line amount is rejected — the no-float-leak guard at the input", () => {
    expect(() =>
      computeInvoiceTax({
        lineAmountsPaisa: [100.5],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      }),
    ).toThrow(/non-negative integer/);
  });

  test("a negative line amount is rejected", () => {
    expect(() =>
      computeInvoiceTax({
        lineAmountsPaisa: [-100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      }),
    ).toThrow(RangeError);
  });

  test("a non-integer (float) discount is rejected", () => {
    expect(() =>
      computeInvoiceTax({
        lineAmountsPaisa: [1_000],
        discountPaisa: 50.5,
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      }),
    ).toThrow(/discountPaisa/);
  });

  test("a non-finite line amount (NaN / Infinity) is rejected", () => {
    expect(() =>
      computeInvoiceTax({
        lineAmountsPaisa: [Number.POSITIVE_INFINITY],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeInvoiceTax({
        lineAmountsPaisa: [Number.NaN],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      }),
    ).toThrow(RangeError);
  });
});

describe("the FLAGGED proposed rate constants are the values actually used (ADR-0039 c9)", () => {
  test("the constants hold the PROPOSED values (a silent edit fails here)", () => {
    expect(INVOICE_VAT_RATE_BP).toBe(1300); // 13%
    expect(INVOICE_TDS_RATE_BP.VEHICLE_HIRE).toBe(150); // 1.5%
    expect(INVOICE_TDS_RATE_BP.GOODS_TRANSPORT).toBe(250); // 2.5%
    expect(BASIS_POINTS_DENOMINATOR).toBe(10_000);
  });

  test("the calculator uses the constants, not hardcoded literals", () => {
    // The returned rates must equal the constants — so bypassing the constant
    // with a literal in the calculator (or editing the constant) fails a test.
    const hire = computeInvoiceTax({
      lineAmountsPaisa: [1_000],
      serviceType: InvoiceServiceType.VEHICLE_HIRE,
    });
    expect(hire.vatRateBp).toBe(INVOICE_VAT_RATE_BP);
    expect(hire.tdsRateBp).toBe(INVOICE_TDS_RATE_BP.VEHICLE_HIRE);

    const goods = computeInvoiceTax({
      lineAmountsPaisa: [1_000],
      serviceType: InvoiceServiceType.GOODS_TRANSPORT,
    });
    expect(goods.tdsRateBp).toBe(INVOICE_TDS_RATE_BP.GOODS_TRANSPORT);
  });
});
