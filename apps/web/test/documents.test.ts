import { describe, expect, test } from "vitest";

import {
  DOCUMENT_CATEGORY_LABELS,
  ENTITY_DOCUMENT_CATEGORIES,
  ENTITY_FIELD,
  formatBytes,
} from "../src/lib/documents";

// Pure-helper tests for the fleet-documents lib (ADR-0049 F4). The matrices
// must mirror the API's documents.schemas.ts — a drift here means the form
// offers a category the API 400s (or hides one it accepts).

describe("ENTITY_DOCUMENT_CATEGORIES (the per-entity matrix)", () => {
  test("mirrors the API matrix per entity", () => {
    expect(ENTITY_DOCUMENT_CATEGORIES.VEHICLE).toEqual([
      "BLUEBOOK",
      "INSURANCE",
      "ROUTE_PERMIT",
      "AGREEMENT",
      "OTHER",
    ]);
    expect(ENTITY_DOCUMENT_CATEGORIES.DRIVER).toEqual([
      "LICENSE",
      "ID_DOCUMENT",
      "AGREEMENT",
      "OTHER",
    ]);
    expect(ENTITY_DOCUMENT_CATEGORIES.CUSTOMER).toEqual(["AGREEMENT", "OTHER"]);
  });

  test("every matrix category carries a display label", () => {
    for (const categories of Object.values(ENTITY_DOCUMENT_CATEGORIES)) {
      for (const category of categories) {
        expect(DOCUMENT_CATEGORY_LABELS[category]).toBeTruthy();
      }
    }
  });

  test("the multipart field name follows the entity", () => {
    expect(ENTITY_FIELD.VEHICLE).toBe("vehicleId");
    expect(ENTITY_FIELD.DRIVER).toBe("driverId");
    expect(ENTITY_FIELD.CUSTOMER).toBe("customerId");
  });
});

describe("formatBytes", () => {
  test("renders bytes, KB, and MB with the table's precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(640)).toBe("640 B");
    expect(formatBytes(12_698)).toBe("12.4 KB");
    expect(formatBytes(320_000)).toBe("313 KB");
    expect(formatBytes(1_258_291)).toBe("1.2 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
  });

  test("degrades to an em-dash on garbage", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});
