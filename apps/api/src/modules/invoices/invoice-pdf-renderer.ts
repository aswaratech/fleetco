// The FleetCo-owned invoice-PDF rendering seam (Program D / ADR-0039 commitment
// 6). This is the ONE place the rest of the API talks to "render an invoice to a
// PDF": the issue flow (D5) and the draft-preview / download paths depend only on
// this `InvoicePdfRenderer` contract and the vendor-free `InvoiceRenderModel`
// shape — never on a PDF SDK. The concrete renderer (`pdfkit` today, per ADR-0039
// c6's recommendation) is named in exactly one implementation file,
// `pdfkit.invoice-pdf-renderer.ts`, so a later swap to the runner-up
// (`@react-pdf/renderer`) changes that one file and nothing that calls
// `InvoicePdfRenderer.render`. This mirrors how `notifications/mailer.ts` wraps
// the email SDK, `common/wkt.ts` centralizes the WKT builder, and
// `@fleetco/shared` `nepali-date.ts` wraps the BS converter: own the seam,
// isolate the dependency (ADR-0039 c6).
//
// WHY AN ABSTRACT CLASS, NOT A BARE `interface` (the Mailer rationale): NestJS
// resolves providers by a runtime token, and a TypeScript `interface` does not
// exist at runtime. An abstract class is BOTH the compile-time contract AND a
// runtime DI token, so the module can wire `{ provide: InvoicePdfRenderer,
// useClass: PdfkitInvoiceRenderer }` and the service injects
// `constructor(private readonly pdf: InvoicePdfRenderer)`. Tests OVERRIDE this
// provider with a recording stub (the issue test's InvoiceSettingsService-stub
// pattern) so they never touch pdfkit's bytes.

import type { DocumentType, InvoiceServiceType } from "@prisma/client";

/**
 * One billable line on the rendered invoice. Money is integer paisa (CLAUDE.md
 * money-as-minor-units); the renderer stringifies it for display only. The line's
 * Bikram Sambat date already rides IN `description` — D4's `buildFromJob` stamps
 * each trip line's BS date into the description (e.g. "Haul aggregate …, 2083
 * Shrawan 3"), so there is no separate per-line date column to format here.
 */
export interface InvoiceRenderLine {
  description: string;
  quantity: number;
  unitPricePaisa: number;
  lineAmountPaisa: number;
}

/**
 * The tax breakdown to render. For an ISSUED invoice this is the FROZEN snapshot
 * read off the row (the historical fact, never recomputed — ADR-0039 c3/c5); for
 * a DRAFT preview it is a PROVISIONAL computation over the current lines (clearly
 * watermarked, no legal standing). The two rates ride in the shape so the printed
 * "VAT (13%)" / "TDS (1.5%)" labels reflect the snapshot's own frozen rates, not
 * a live constant. All amounts integer paisa.
 */
export interface InvoiceRenderTax {
  subtotalPaisa: number;
  discountPaisa: number;
  vatRateBp: number;
  vatPaisa: number;
  grossPaisa: number;
  tdsRateBp: number;
  tdsPaisa: number;
  netReceivablePaisa: number;
  serviceType: InvoiceServiceType;
}

/**
 * The FleetCo-owned render contract — a vendor-free description of what to put on
 * the page. The service builds this from an `InvoiceDetail` + the operator-
 * supplied supplier identity (D5's `buildRenderModel`); the renderer turns it
 * into PDF bytes. Decoupled from the Prisma row so the renderer is trivially
 * fixture-testable and so a vendor swap never touches the data-assembly code.
 *
 * Dates are carried as ISO strings (storage stays ISO/UTC — DESIGN.md
 * anti-pattern #12) and rendered Bikram Sambat by the renderer via
 * `formatNepaliDate` (ADR-0031 / ADR-0039 c8).
 */
export interface InvoiceRenderModel {
  /** INVOICE → "Tax Invoice"; CREDIT_NOTE → "Credit Note" (ADR-0039 c5). */
  documentType: DocumentType;
  /** The gapless fiscal-year number (e.g. "INV-2082-83-00001"); NULL on a DRAFT
   * preview (unissued — it has no number yet). */
  number: string | null;
  /** The issue date (ISO/UTC), rendered Bikram Sambat; NULL on a DRAFT preview. */
  issuedAtIso: string | null;
  /** FleetCo's own (seller) name — operator-supplied, defaulting to "FleetCo". */
  supplierName: string;
  /** FleetCo's own (seller) PAN/VAT number — operator-supplied (ADR-0039 c9),
   * NULL only on a DRAFT preview rendered before it is configured (an ISSUED
   * invoice always has one; `issue()` refuses without it). NEVER fabricated. */
  supplierPan: string | null;
  /** The buyer's name. */
  customerName: string;
  /** The buyer's PAN (`Customer.panNumber`), or NULL when the customer has none. */
  customerPan: string | null;
  /** The provenance job number (`Job.jobNumber`), or NULL for a job-less invoice. */
  jobNumber: string | null;
  lines: InvoiceRenderLine[];
  /** The tax breakdown — frozen (issued) or provisional (draft). NULL only when a
   * DRAFT preview has no `serviceType` yet (the TDS rate is unselectable), in
   * which case the renderer shows the lines + a "tax shown at issue" note. */
  tax: InvoiceRenderTax | null;
  /** A diagonal watermark string for a non-legal copy (e.g. "DRAFT — NOT A VALID
   * TAX INVOICE"); NULL for the ISSUED legal artifact (ADR-0039 c7). */
  watermark: string | null;
}

/**
 * The invoice-PDF rendering port. One method. The issue flow + the preview/
 * download paths depend on this — not on any PDF vendor. See the file header for
 * why this is an abstract class (a runtime DI token), not a bare `interface`.
 */
export abstract class InvoicePdfRenderer {
  /**
   * Render the model to a complete PDF document, resolved as a single Buffer.
   * REJECTS (never returns a partial buffer) if the underlying library throws, so
   * the issue flow's transaction rolls back and never burns a gapless number on a
   * render failure (ADR-0039 c7 side-effect ordering).
   */
  abstract render(invoice: InvoiceRenderModel): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Pure presentation helpers — exported so they are pinned by focused unit tests
// and shared by the one renderer implementation. Money is integer paisa in code;
// these stringify ONLY at the render boundary (the apps/web `money.ts` round-trip
// discipline: never parse a formatted string back to a number).
// ---------------------------------------------------------------------------

// Mirrors apps/web `formatNpr` (Intl en-IN currency NPR) with ONE deliberate
// divergence for the PDF medium: `currencyDisplay: "code"` forces the Latin "NPR"
// prefix. The PDF's base font is Helvetica (a Latin-only standard PDF font); a
// localized rupee glyph (₨ / रू) some ICU builds emit would render as a missing
// glyph. Forcing the currency CODE keeps every money string Latin-safe.
const NPR_PDF_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "NPR",
  currencyDisplay: "code",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format an integer-paisa amount as a Latin-safe NPR string for the PDF.
 *   formatNprFromPaisa(0)        → "NPR 0.00"
 *   formatNprFromPaisa(123_456)  → "NPR 1,234.56"
 *   formatNprFromPaisa(1_235_050)→ "NPR 12,350.50"
 * A non-finite value renders as the em-dash (the apps/web convention).
 */
export function formatNprFromPaisa(paisa: number): string {
  if (!Number.isFinite(paisa)) return "—";
  // The /100 stays inside the call so the rupees decimal is never bound to a
  // variable — keeping the "money is paisa" invariant honest (the web precedent).
  return NPR_PDF_FORMATTER.format(paisa / 100);
}

/**
 * Format a basis-point rate as a human percent for the printed tax labels.
 *   1300 → "13%"   150 → "1.5%"   250 → "2.5%"   1325 → "13.25%"
 * Trailing zeros are stripped so the common whole/half rates read cleanly.
 */
export function formatRateBpAsPercent(rateBp: number): string {
  // rateBp/100 = percent; round to 2 dp then drop trailing zeros via parseFloat.
  return `${parseFloat((rateBp / 100).toFixed(2)).toString()}%`;
}
