import { describe, expect, test } from "vitest";

import {
  formatNprFromPaisa,
  formatRateBpAsPercent,
  type InvoiceRenderModel,
} from "../src/modules/invoices/invoice-pdf-renderer";
import { PdfkitInvoiceRenderer } from "../src/modules/invoices/pdfkit.invoice-pdf-renderer";

// The PDF renderer unit test (Program D / ADR-0039 c6, D5). PURE — no DB, no Nest
// module: instantiate the real pdfkit-backed renderer and assert it produces a
// well-formed PDF for a fixture. Per the D5 ticket we assert the `%PDF` MAGIC
// BYTES, NOT a brittle byte-for-byte hash (pdfkit stamps a random file /ID in the
// trailer per render — the document CONTENT is deterministic, the /ID is not, and
// the frozen-once-at-issue store is what makes the issued artifact stable, not
// render determinism).

const renderer = new PdfkitInvoiceRenderer();

/** A magic-bytes assertion: every PDF begins with the "%PDF-" header. */
function expectPdf(buffer: Buffer): void {
  expect(Buffer.isBuffer(buffer)).toBe(true);
  expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // A real document is more than a header; a few hundred bytes minimum.
  expect(buffer.length).toBeGreaterThan(300);
}

const ISSUED_INVOICE: InvoiceRenderModel = {
  documentType: "INVOICE",
  number: "INV-2082-83-00001",
  issuedAtIso: "2025-08-01T00:00:00.000Z",
  supplierName: "FleetCo",
  supplierPan: "TEST-SUPPLIER-PAN",
  customerName: "Acme Constructions Pvt. Ltd.",
  customerPan: "301234567",
  jobNumber: "JOB-2025-00042",
  lines: [
    {
      description: "Haul aggregate Kalimati to Pokhara, 2082 Shrawan 16",
      quantity: 1,
      unitPricePaisa: 1_000_000,
      lineAmountPaisa: 1_000_000,
    },
    {
      description: "Mobilization fee",
      quantity: 1,
      unitPricePaisa: 235_050,
      lineAmountPaisa: 235_050,
    },
  ],
  tax: {
    subtotalPaisa: 1_235_050,
    discountPaisa: 0,
    vatRateBp: 1300,
    vatPaisa: 160_557,
    grossPaisa: 1_395_607,
    tdsRateBp: 150,
    tdsPaisa: 18_526,
    netReceivablePaisa: 1_377_081,
    serviceType: "VEHICLE_HIRE",
  },
  watermark: null,
};

describe("PdfkitInvoiceRenderer.render", () => {
  test("renders an issued tax invoice to a %PDF buffer", async () => {
    const buffer = await renderer.render(ISSUED_INVOICE);
    expectPdf(buffer);
  });

  test("renders a watermarked DRAFT preview (no number, no issue date)", async () => {
    const draft: InvoiceRenderModel = {
      ...ISSUED_INVOICE,
      number: null,
      issuedAtIso: null,
      watermark: "DRAFT — NOT A VALID TAX INVOICE",
    };
    const buffer = await renderer.render(draft);
    expectPdf(buffer);
  });

  test("renders a credit note", async () => {
    const creditNote: InvoiceRenderModel = {
      ...ISSUED_INVOICE,
      documentType: "CREDIT_NOTE",
      number: "CRN-2082-83-00001",
    };
    const buffer = await renderer.render(creditNote);
    expectPdf(buffer);
  });

  test("renders a discounted, goods-transport invoice (the other TDS rate)", async () => {
    const discounted: InvoiceRenderModel = {
      ...ISSUED_INVOICE,
      tax: {
        subtotalPaisa: 1_000_000,
        discountPaisa: 100_000,
        vatRateBp: 1300,
        vatPaisa: 117_000,
        grossPaisa: 1_017_000,
        tdsRateBp: 250,
        tdsPaisa: 22_500,
        netReceivablePaisa: 994_500,
        serviceType: "GOODS_TRANSPORT",
      },
    };
    const buffer = await renderer.render(discounted);
    expectPdf(buffer);
  });

  test("renders a draft with no service type yet (tax === null)", async () => {
    const noTax: InvoiceRenderModel = {
      ...ISSUED_INVOICE,
      number: null,
      issuedAtIso: null,
      tax: null,
      supplierPan: null,
      watermark: "DRAFT — NOT A VALID TAX INVOICE",
    };
    const buffer = await renderer.render(noTax);
    expectPdf(buffer);
  });

  test("renders an invoice with no buyer PAN and no job (nullable fields)", async () => {
    const minimal: InvoiceRenderModel = {
      ...ISSUED_INVOICE,
      customerPan: null,
      jobNumber: null,
    };
    const buffer = await renderer.render(minimal);
    expectPdf(buffer);
  });
});

describe("formatNprFromPaisa", () => {
  test("formats integer paisa as a Latin-safe NPR string", () => {
    expect(formatNprFromPaisa(0)).toMatch(/^NPR\s0\.00$/);
    expect(formatNprFromPaisa(123_456)).toMatch(/^NPR\s1,234\.56$/);
    expect(formatNprFromPaisa(1_235_050)).toMatch(/^NPR\s12,350\.50$/);
  });

  test("never emits a non-Latin currency glyph (Helvetica-safe code prefix)", () => {
    // currencyDisplay:"code" guarantees the "NPR" Latin code, never ₨ / रू.
    expect(formatNprFromPaisa(15_000)).toContain("NPR");
    expect(formatNprFromPaisa(15_000)).not.toMatch(/[₨रू]/);
  });

  test("renders a non-finite amount as the em-dash", () => {
    expect(formatNprFromPaisa(Number.NaN)).toBe("—");
    expect(formatNprFromPaisa(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatRateBpAsPercent", () => {
  test("renders the proposed VAT/TDS rates cleanly", () => {
    expect(formatRateBpAsPercent(1300)).toBe("13%");
    expect(formatRateBpAsPercent(150)).toBe("1.5%");
    expect(formatRateBpAsPercent(250)).toBe("2.5%");
  });

  test("renders a fractional rate without losing precision", () => {
    expect(formatRateBpAsPercent(1325)).toBe("13.25%");
    expect(formatRateBpAsPercent(0)).toBe("0%");
  });
});
