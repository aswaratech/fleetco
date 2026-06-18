import { formatNepaliDate } from "@fleetco/shared";
import type { InvoiceServiceType } from "@prisma/client";
import PDFDocument from "pdfkit";

import {
  InvoicePdfRenderer,
  formatNprFromPaisa,
  formatRateBpAsPercent,
  type InvoiceRenderLine,
  type InvoiceRenderModel,
} from "./invoice-pdf-renderer";

// The `pdfkit` implementation of the FleetCo {@link InvoicePdfRenderer} seam
// (Program D / ADR-0039 commitment 6). This is the ONLY file in the API that
// imports `pdfkit` (or names any PDF vendor): everything upstream — the issue
// flow, the draft preview, the download path — depends on the vendor-free
// `InvoicePdfRenderer` contract + the `InvoiceRenderModel` shape, so swapping to
// the runner-up (`@react-pdf/renderer`) later means rewriting this one file and
// nothing else (the seam guarantee, c6). Not @Injectable(): the module factory
// constructs it directly (`new PdfkitInvoiceRenderer()`), the ResendMailer
// precedent — a renderer needs no env/creds, so it is always available.
//
// ⚠️ DEVANAGARI "कर बीजक" LABEL — FLAGGED, NOT SHIPPED (ADR-0039 c9 + the D5
// ticket's "flag it rather than ship mojibake"). pdfkit's 14 built-in fonts are
// the standard PDF fonts (Helvetica/Times/Courier) — Latin-only. Passing the
// Devanagari label `कर बीजक` to a Latin font renders missing-glyph boxes
// (mojibake). Rendering it correctly server-side needs an embedded Devanagari TTF
// (DESIGN.md §Devanagari names Noto Sans Devanagari, SIL OFL) — but no such font
// is bundled in the API, and adding a font dependency is NOT in ADR-0039's
// accepted scope (it proposed the PDF lib + the R2 client only; a font package /
// committed binary needs its own proposal per CLAUDE.md). So v1 prints the
// English **"Tax Invoice"** label (the legally-clear bilingual partner IRD
// invoices carry) and leaves the Devanagari as the labelled seam below
// (TAX_INVOICE_LABEL_NE) for the follow-up that bundles the font. The exact
// IRD-prescribed field set + labelling is operator/accountant-verify regardless
// (ADR-0039 c9), so the printed layout here is PROPOSED, not statutory.

// The Devanagari label, kept as a labelled constant (NOT drawn) so the
// font-bundling follow-up has a single place to wire it in. See the file header.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TAX_INVOICE_LABEL_NE = "कर बीजक";

// A4 geometry (points). margin 50 → a ~495pt content band.
const PAGE_MARGIN = 50;
const A4_WIDTH = 595.28;
const CONTENT_LEFT = PAGE_MARGIN;
const CONTENT_RIGHT = A4_WIDTH - PAGE_MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

// Line-table column geometry. Description flows + wraps; the three numeric
// columns are right-aligned so digits line up (the tabular-numerals intent).
const COL_DESC_X = CONTENT_LEFT;
const COL_DESC_W = 245;
const COL_QTY_X = 300;
const COL_QTY_W = 45;
const COL_UNIT_X = 350;
const COL_UNIT_W = 90;
const COL_AMT_X = 445;
const COL_AMT_W = CONTENT_RIGHT - COL_AMT_X;

// Restrained, professional palette (the PDF is its own medium — not bound to the
// web theme tokens). Black text, a light header-row fill, a muted-rose watermark.
const COLOR_TEXT = "#111827";
const COLOR_MUTED = "#6b7280";
const COLOR_RULE = "#d1d5db";
const COLOR_HEADER_FILL = "#f3f4f6";
const COLOR_WATERMARK = "#e11d48";

export class PdfkitInvoiceRenderer extends InvoicePdfRenderer {
  async render(invoice: InvoiceRenderModel): Promise<Buffer> {
    const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN });
    // The PDF's own CreationDate = the issue moment when issued (so the document
    // metadata matches the invoice); the wall clock otherwise. Storage stays
    // ISO/UTC; this is metadata only.
    doc.info.CreationDate = invoice.issuedAtIso ? new Date(invoice.issuedAtIso) : new Date();
    doc.info.Title = invoice.number ?? "Invoice (draft)";

    const chunks: Buffer[] = [];
    return await new Promise<Buffer>((resolve, reject) => {
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
      try {
        this.draw(doc, invoice);
        doc.end();
      } catch (error) {
        // Surface a render bug as a rejection so the issue transaction rolls back
        // (no burned number) rather than resolving a half-built buffer.
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private draw(doc: PDFKit.PDFDocument, invoice: InvoiceRenderModel): void {
    if (invoice.watermark) {
      this.drawWatermark(doc, invoice.watermark);
    }
    this.drawTitle(doc, invoice);
    this.drawParties(doc, invoice);
    this.drawLineTable(doc, invoice.lines);
    this.drawTotals(doc, invoice);
    this.drawFooter(doc);
  }

  /** A diagonal, low-opacity watermark across page 1 (the non-legal copy mark,
   * ADR-0039 c7). v1 invoices are single-page; an overflow page would lack it —
   * acceptable for the short documents v1 produces. */
  private drawWatermark(doc: PDFKit.PDFDocument, text: string): void {
    const { width, height } = doc.page;
    doc.save();
    doc.rotate(-45, { origin: [width / 2, height / 2] });
    doc
      .font("Helvetica-Bold")
      .fontSize(56)
      .fillColor(COLOR_WATERMARK)
      .opacity(0.12)
      .text(text, width / 2 - 320, height / 2 - 28, { width: 640, align: "center" });
    doc.restore();
    // Restore content defaults (save/restore covers the graphics state, but be
    // explicit so subsequent text is full-opacity black regardless).
    doc.fillColor(COLOR_TEXT).opacity(1);
  }

  private drawTitle(doc: PDFKit.PDFDocument, invoice: InvoiceRenderModel): void {
    // English label per the file-header flag (the Devanagari कर बीजक awaits a
    // bundled font). "Tax Invoice" for an INVOICE; "Credit Note" for a CREDIT_NOTE.
    const label = invoice.documentType === "CREDIT_NOTE" ? "Credit Note" : "Tax Invoice";
    doc
      .font("Helvetica-Bold")
      .fontSize(22)
      .fillColor(COLOR_TEXT)
      .text(label, CONTENT_LEFT, PAGE_MARGIN);
    doc.moveDown(0.5);
    // A thin rule under the title.
    const y = doc.y;
    doc
      .moveTo(CONTENT_LEFT, y)
      .lineTo(CONTENT_RIGHT, y)
      .lineWidth(1)
      .strokeColor(COLOR_RULE)
      .stroke();
    doc.moveDown(0.75);
  }

  /** Two columns: the supplier identity (left) and the document meta — number,
   * issue date (Bikram Sambat), service type (right) — then the bill-to block. */
  private drawParties(doc: PDFKit.PDFDocument, invoice: InvoiceRenderModel): void {
    const topY = doc.y;
    const rightX = 320;

    // Left: supplier (seller) identity.
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COLOR_MUTED)
      .text("SUPPLIER", CONTENT_LEFT, topY);
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(COLOR_TEXT)
      .text(invoice.supplierName, CONTENT_LEFT);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(COLOR_TEXT)
      .text(`PAN: ${invoice.supplierPan ?? "— (not configured)"}`, CONTENT_LEFT);

    // Right: document meta. Render at the same topY in the right column.
    doc.font("Helvetica-Bold").fontSize(9).fillColor(COLOR_MUTED).text("DOCUMENT", rightX, topY);
    const issueDate = invoice.issuedAtIso
      ? formatNepaliDate(invoice.issuedAtIso)
      : "Draft (unissued)";
    doc.font("Helvetica").fontSize(10).fillColor(COLOR_TEXT);
    doc.text(`Number: ${invoice.number ?? "— (assigned at issue)"}`, rightX);
    doc.text(`Issue date: ${issueDate}`, rightX);
    if (invoice.tax) {
      doc.text(`Service type: ${serviceTypeLabel(invoice.tax.serviceType)}`, rightX);
    }

    // Move below whichever column is taller, then the bill-to block.
    doc.moveDown(1.5);
    const billY = doc.y;
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COLOR_MUTED)
      .text("BILL TO", CONTENT_LEFT, billY);
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(COLOR_TEXT)
      .text(invoice.customerName, CONTENT_LEFT);
    doc.font("Helvetica").fontSize(10).fillColor(COLOR_TEXT);
    doc.text(`PAN: ${invoice.customerPan ?? "—"}`, CONTENT_LEFT);
    if (invoice.jobNumber) {
      doc.text(`Job: ${invoice.jobNumber}`, CONTENT_LEFT);
    }
    doc.moveDown(1);
  }

  private drawLineTable(doc: PDFKit.PDFDocument, lines: InvoiceRenderLine[]): void {
    // Header row with a light fill.
    let y = doc.y;
    doc.rect(CONTENT_LEFT, y, CONTENT_WIDTH, 20).fill(COLOR_HEADER_FILL);
    doc.fillColor(COLOR_TEXT).font("Helvetica-Bold").fontSize(9);
    const headerTextY = y + 6;
    doc.text("DESCRIPTION", COL_DESC_X + 4, headerTextY, { width: COL_DESC_W });
    doc.text("QTY", COL_QTY_X, headerTextY, { width: COL_QTY_W, align: "right" });
    doc.text("UNIT PRICE", COL_UNIT_X, headerTextY, { width: COL_UNIT_W, align: "right" });
    doc.text("AMOUNT", COL_AMT_X, headerTextY, { width: COL_AMT_W - 4, align: "right" });
    y += 20;

    doc.font("Helvetica").fontSize(10).fillColor(COLOR_TEXT);
    for (const line of lines) {
      // Page-break guard: a long ledger of lines flows to a new page.
      if (y > doc.page.height - 160) {
        doc.addPage();
        y = doc.y;
      }
      const descHeight = doc.heightOfString(line.description, { width: COL_DESC_W - 4 });
      const rowHeight = Math.max(descHeight, 14) + 6;
      const cellY = y + 3;
      doc.text(line.description, COL_DESC_X + 4, cellY, { width: COL_DESC_W - 4 });
      doc.text(String(line.quantity), COL_QTY_X, cellY, { width: COL_QTY_W, align: "right" });
      doc.text(formatNprFromPaisa(line.unitPricePaisa), COL_UNIT_X, cellY, {
        width: COL_UNIT_W,
        align: "right",
      });
      doc.text(formatNprFromPaisa(line.lineAmountPaisa), COL_AMT_X, cellY, {
        width: COL_AMT_W - 4,
        align: "right",
      });
      y += rowHeight;
      doc
        .moveTo(CONTENT_LEFT, y)
        .lineTo(CONTENT_RIGHT, y)
        .lineWidth(0.5)
        .strokeColor(COLOR_RULE)
        .stroke();
    }
    doc.y = y + 8;
  }

  /** The right-aligned totals stack. For an ISSUED invoice these are the FROZEN
   * figures; for a DRAFT preview they are provisional (or, with no service type,
   * just the line subtotal + a "shown at issue" note). */
  private drawTotals(doc: PDFKit.PDFDocument, invoice: InvoiceRenderModel): void {
    const labelX = 300;
    const labelW = 140;
    const valueX = COL_AMT_X;
    const valueW = COL_AMT_W - 4;
    let y = doc.y;

    const row = (
      label: string,
      value: string,
      opts?: { bold?: boolean; muted?: boolean },
    ): void => {
      if (y > doc.page.height - 120) {
        doc.addPage();
        y = doc.y;
      }
      doc
        .font(opts?.bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(10)
        .fillColor(opts?.muted ? COLOR_MUTED : COLOR_TEXT);
      doc.text(label, labelX, y, { width: labelW, align: "right" });
      doc.text(value, valueX, y, { width: valueW, align: "right" });
      y += 16;
    };

    const tax = invoice.tax;
    if (!tax) {
      // A draft with no service type yet: show the line subtotal, defer the tax.
      const subtotal = invoice.lines.reduce((sum, l) => sum + l.lineAmountPaisa, 0);
      row("Subtotal", formatNprFromPaisa(subtotal));
      doc.y = y + 2;
      doc
        .font("Helvetica-Oblique")
        .fontSize(9)
        .fillColor(COLOR_MUTED)
        .text("VAT / TDS shown at issue (select a service type first).", labelX, doc.y, {
          width: labelW + valueW,
          align: "right",
        });
      doc.moveDown(1);
      return;
    }

    row("Subtotal", formatNprFromPaisa(tax.subtotalPaisa));
    if (tax.discountPaisa > 0) {
      row("Discount", `- ${formatNprFromPaisa(tax.discountPaisa)}`);
      row("Taxable value", formatNprFromPaisa(tax.subtotalPaisa - tax.discountPaisa));
    }
    row(`VAT (${formatRateBpAsPercent(tax.vatRateBp)})`, formatNprFromPaisa(tax.vatPaisa));
    // Gross total — the amount legally billed to the customer (emphasized).
    row("Gross total", formatNprFromPaisa(tax.grossPaisa), { bold: true });

    // A thin separator, then the TDS memo block (withheld by the payer — it does
    // NOT change the gross billed; it shows FleetCo's expected net receivable).
    y += 4;
    doc.moveTo(labelX, y).lineTo(CONTENT_RIGHT, y).lineWidth(0.5).strokeColor(COLOR_RULE).stroke();
    y += 6;
    row(
      `TDS (${formatRateBpAsPercent(tax.tdsRateBp)}) — withheld by payer`,
      `- ${formatNprFromPaisa(tax.tdsPaisa)}`,
      { muted: true },
    );
    row("Net receivable", formatNprFromPaisa(tax.netReceivablePaisa), { bold: true });
    doc.y = y + 6;
  }

  private drawFooter(doc: PDFKit.PDFDocument): void {
    doc.moveDown(2);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(COLOR_MUTED)
      .text(
        "Amounts in NPR, computed in integer paisa with half-up rounding. VAT/TDS rates and the " +
          "invoice field set are PROPOSED pending operator/accountant verification (ADR-0039). " +
          "TDS is withheld and remitted to the IRD by the payer; it does not change the gross billed.",
        CONTENT_LEFT,
        doc.y,
        { width: CONTENT_WIDTH, align: "left" },
      );
  }
}

/** Human label for the service-type discriminator (printed on the document). */
function serviceTypeLabel(serviceType: InvoiceServiceType): string {
  return serviceType === "GOODS_TRANSPORT" ? "Goods transport" : "Vehicle hire";
}
