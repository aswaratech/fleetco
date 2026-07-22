import { describe, expect, test } from "vitest";

import {
  DOCUMENT_CATEGORY_FOR_KIND,
  EXPENSE_CATEGORIES_FOR_KIND,
  isRenewalKind,
  RENEWAL_KIND_LABELS,
  RENEWAL_KINDS,
} from "../src/lib/renewals";

// Drift pins for the renewals lib (ADR-0049 F5): these maps must mirror the
// API's renewals.service.ts — a drift means the form offers a proof/cost
// option the API 400s, or hides one it accepts.

describe("renewal kind vocabulary", () => {
  test("mirrors the API's RenewalKind enum", () => {
    expect(RENEWAL_KINDS).toEqual(["BLUEBOOK", "INSURANCE", "ROUTE_PERMIT"]);
    for (const kind of RENEWAL_KINDS) {
      expect(RENEWAL_KIND_LABELS[kind]).toBeTruthy();
    }
  });

  test("isRenewalKind narrows exactly the three kinds", () => {
    expect(isRenewalKind("BLUEBOOK")).toBe(true);
    expect(isRenewalKind("INSURANCE")).toBe(true);
    expect(isRenewalKind("ROUTE_PERMIT")).toBe(true);
    expect(isRenewalKind("MAINTENANCE")).toBe(false);
    expect(isRenewalKind(undefined)).toBe(false);
    expect(isRenewalKind("")).toBe(false);
  });
});

describe("per-kind link filters (mirror the API's maps)", () => {
  test("proof-document categories match kind for kind", () => {
    expect(DOCUMENT_CATEGORY_FOR_KIND).toEqual({
      BLUEBOOK: "BLUEBOOK",
      INSURANCE: "INSURANCE",
      ROUTE_PERMIT: "ROUTE_PERMIT",
    });
  });

  test("cost-expense categories match the API's per-kind sets", () => {
    expect(EXPENSE_CATEGORIES_FOR_KIND.BLUEBOOK).toEqual(["PERMIT", "OTHER"]);
    expect(EXPENSE_CATEGORIES_FOR_KIND.INSURANCE).toEqual(["INSURANCE"]);
    expect(EXPENSE_CATEGORIES_FOR_KIND.ROUTE_PERMIT).toEqual(["PERMIT"]);
  });
});
