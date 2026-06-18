import { describe, expect, test } from "vitest";

import {
  computeInvoiceTaxPreview,
  computeTaxPaisa,
  formatRateBpPercent,
  PREVIEW_TDS_RATE_BP,
  PREVIEW_VAT_RATE_BP,
} from "../src/lib/invoices-tax";

/**
 * Pins the client-side VAT/TDS PREVIEW helper (D6 / ADR-0039 c3, c8). This is a
 * faithful mirror of the API's `computeInvoiceTax` (apps/api invoice-tax.ts); the
 * worked examples below are the SAME ones the API test pins, so the web preview
 * provably equals the server-frozen snapshot bit-for-bit (the half-up integer-
 * paisa guarantee). The API is authoritative — this preview never decides a stored
 * number — but the operator must see the right number before they issue.
 */
describe("computeTaxPaisa (half-up, integer paisa)", () => {
  test("rounds the .5 boundary up (50 paisa × 1300 bp = 6.5 → 7)", () => {
    // Truncation → 6, banker's → 6 (6 is even); 7 is the half-up signature.
    expect(computeTaxPaisa(50, 1300)).toBe(7);
  });

  test("an exact product does not drift (800000 × 1300 / 10000 = 104000)", () => {
    expect(computeTaxPaisa(800_000, 1300)).toBe(104_000);
  });
});

describe("PROPOSED rate constants mirror the API (ADR-0039 c9)", () => {
  test("VAT is 1300 bp (13%)", () => {
    expect(PREVIEW_VAT_RATE_BP).toBe(1300);
  });
  test("TDS is 150 bp vehicle-hire / 250 bp goods-transport", () => {
    expect(PREVIEW_TDS_RATE_BP.VEHICLE_HIRE).toBe(150);
    expect(PREVIEW_TDS_RATE_BP.GOODS_TRANSPORT).toBe(250);
  });
});

describe("computeInvoiceTaxPreview", () => {
  test("the API's worked example (two lines, no discount, VEHICLE_HIRE)", () => {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: [1_000_000, 235_050],
      serviceType: "VEHICLE_HIRE",
    });
    expect(preview).not.toBeNull();
    expect(preview).toMatchObject({
      subtotalPaisa: 1_235_050,
      discountPaisa: 0,
      taxablePaisa: 1_235_050,
      vatRateBp: 1300,
      vatPaisa: 160_557, // round(160_556.5) half-up
      grossPaisa: 1_395_607,
      tdsRateBp: 150,
      tdsPaisa: 18_526, // round(18_525.75)
      netReceivablePaisa: 1_377_081,
      serviceType: "VEHICLE_HIRE",
    });
  });

  test("GOODS_TRANSPORT selects the 2.5% TDS rate", () => {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: [1_235_050],
      serviceType: "GOODS_TRANSPORT",
    });
    expect(preview?.tdsRateBp).toBe(250);
    expect(preview?.tdsPaisa).toBe(30_876); // round(30_876.25)
  });

  test("a discount reduces the taxable base (the discounted figure is taxable)", () => {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: [1_000_000],
      discountPaisa: 200_000,
      serviceType: "VEHICLE_HIRE",
    });
    expect(preview).toMatchObject({
      subtotalPaisa: 1_000_000,
      discountPaisa: 200_000,
      taxablePaisa: 800_000,
      vatPaisa: 104_000,
      grossPaisa: 904_000,
      tdsPaisa: 12_000,
      netReceivablePaisa: 892_000,
    });
  });

  test("TDS is a memo — it never changes the gross billed", () => {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: [500_000],
      serviceType: "VEHICLE_HIRE",
    });
    // gross = taxable + VAT, independent of TDS.
    expect(preview?.grossPaisa).toBe(500_000 + computeTaxPaisa(500_000, 1300));
    // net = gross − TDS.
    expect(preview?.netReceivablePaisa).toBe((preview?.grossPaisa ?? 0) - (preview?.tdsPaisa ?? 0));
  });

  test("an empty line set yields an all-zero preview (not null)", () => {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: [],
      serviceType: "VEHICLE_HIRE",
    });
    expect(preview).toMatchObject({
      subtotalPaisa: 0,
      vatPaisa: 0,
      grossPaisa: 0,
      tdsPaisa: 0,
      netReceivablePaisa: 0,
    });
  });

  test("a discount exceeding the subtotal previews as null (not-yet-valid)", () => {
    const preview = computeInvoiceTaxPreview({
      lineAmountsPaisa: [100_000],
      discountPaisa: 200_000,
      serviceType: "VEHICLE_HIRE",
    });
    expect(preview).toBeNull();
  });

  test("a non-integer / negative line amount previews as null", () => {
    expect(
      computeInvoiceTaxPreview({ lineAmountsPaisa: [10.5], serviceType: "VEHICLE_HIRE" }),
    ).toBeNull();
    expect(
      computeInvoiceTaxPreview({ lineAmountsPaisa: [-100], serviceType: "VEHICLE_HIRE" }),
    ).toBeNull();
  });

  test("a negative or non-integer discount previews as null", () => {
    // The discount-validity branch (distinct from discount > subtotal above): a
    // negative or fractional discount is not yet valid, so the preview is withheld.
    expect(
      computeInvoiceTaxPreview({
        lineAmountsPaisa: [100_000],
        discountPaisa: -1,
        serviceType: "VEHICLE_HIRE",
      }),
    ).toBeNull();
    expect(
      computeInvoiceTaxPreview({
        lineAmountsPaisa: [100_000],
        discountPaisa: 10.5,
        serviceType: "VEHICLE_HIRE",
      }),
    ).toBeNull();
  });
});

describe("formatRateBpPercent", () => {
  test("renders whole and fractional percents, trailing zeros stripped", () => {
    expect(formatRateBpPercent(1300)).toBe("13%");
    expect(formatRateBpPercent(150)).toBe("1.5%");
    expect(formatRateBpPercent(250)).toBe("2.5%");
  });
  test("null / undefined renders the em-dash", () => {
    expect(formatRateBpPercent(null)).toBe("—");
    expect(formatRateBpPercent(undefined)).toBe("—");
  });
  test("a non-finite rate (NaN / Infinity) renders the em-dash", () => {
    expect(formatRateBpPercent(Number.NaN)).toBe("—");
    expect(formatRateBpPercent(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
