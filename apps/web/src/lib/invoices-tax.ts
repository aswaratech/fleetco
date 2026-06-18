// Client-side VAT + TDS preview for the invoicing web surface (Program D / D6 /
// ADR-0039 commitment 3 + commitment 8).
//
// This is a faithful, PURE mirror of the API's `computeInvoiceTax`
// (apps/api/src/modules/invoices/invoice-tax.ts) and its rate constants
// (invoice-tax.constants.ts), used ONLY to render a DRAFT invoice's PROVISIONAL
// tax breakdown before the operator issues it. The API is authoritative: at
// issue the server recomputes and FREEZES the snapshot onto the invoice
// (ADR-0039 c3/c5), and an ISSUED invoice's web detail renders those FROZEN
// columns, never this preview. So this helper never decides a stored number — it
// only previews one.
//
// Duplication-budget rationale (the established FleetCo pattern): the same
// integer-paisa half-up math is mirrored, not imported, the way the mobile
// driver app's `fuel.ts` mirrors the web fuel converters and `geofences-schema.ts`
// mirrors the API's WKT bounds — a shared @fleetco/shared home is deferred until
// the duplication actually bites. Because both sides use the identical `Math.round`
// half-up rule over identical integer inputs, the preview equals the persisted
// snapshot bit-for-bit (the same guarantee the fuel-log total-cost preview makes).
//
// Money is integer paisa end-to-end (CLAUDE.md money-as-minor-units); this module
// never introduces a float (anti-pattern #14). The rates are basis points.

import type { InvoiceServiceType } from "@/app/invoices/types";

// ⚠️ PROPOSED — pending operator/accountant verification (ADR-0039 c9). These
// mirror the FLAGGED proposed constants the API freezes at issue
// (apps/api/src/modules/invoices/invoice-tax.constants.ts). The PO accepted
// BUILDING NOW with these proposed values (ADR-0039 ## Acceptance, 2026-06-18);
// the verification against current Inland Revenue Department (IRD) rules is a
// DEFERRED operator gate before any real billing, NOT a pre-build gate. This is a
// PREVIEW only — the authoritative rate is whatever the API freezes onto the
// invoice at issue.
//
// PROPOSED — operator/accountant must verify before real use (ADR-0039 c9)
export const PREVIEW_VAT_RATE_BP = 1300; // 13% standard Nepal VAT

// PROPOSED — operator/accountant must verify before real use (ADR-0039 c9)
//   VEHICLE_HIRE    150 bp = 1.5% — vehicle / equipment hire
//   GOODS_TRANSPORT 250 bp = 2.5% — goods carriage (transport) within Nepal
export const PREVIEW_TDS_RATE_BP: Record<InvoiceServiceType, number> = {
  VEHICLE_HIRE: 150,
  GOODS_TRANSPORT: 250,
};

// A rate in basis points / 10_000 = the fraction (1300 / 10_000 = 0.13). Named so
// the math reads `taxable * rateBp / BASIS_POINTS_DENOMINATOR`, not a magic 10000.
export const BASIS_POINTS_DENOMINATOR = 10_000;

/** The previewed tax breakdown — the same shape as the API's frozen
 * `InvoiceTaxSnapshot`, all integer paisa. */
export interface InvoiceTaxPreview {
  /** Σ of the line amounts, integer paisa, BEFORE any discount. */
  subtotalPaisa: number;
  /** The discount applied (0 when none). */
  discountPaisa: number;
  /** subtotal − discount; the taxable base (ADR-0039 c3). */
  taxablePaisa: number;
  /** The VAT rate in basis points used for the preview. */
  vatRateBp: number;
  /** VAT = round(taxable * vatRateBp / 10000), integer paisa, half-up. */
  vatPaisa: number;
  /** gross = taxable + VAT — the amount billed to the customer. */
  grossPaisa: number;
  /** The TDS rate in basis points used for the preview. */
  tdsRateBp: number;
  /** TDS = round(taxable * tdsRateBp / 10000), integer paisa, half-up. A MEMO:
   * withheld by the payer; does NOT change `grossPaisa`. */
  tdsPaisa: number;
  /** net receivable = gross − TDS — the cash FleetCo expects. */
  netReceivablePaisa: number;
  /** The service type the TDS rate was selected from. */
  serviceType: InvoiceServiceType;
}

/**
 * Compute a tax amount in integer paisa from a base and a basis-point rate,
 * half-up — the API's `computeTaxPaisa` rule (the FuelLogsService half-up
 * precedent generalized to a rate). Integer in, integer out.
 */
export function computeTaxPaisa(basePaisa: number, rateBp: number): number {
  return Math.round((basePaisa * rateBp) / BASIS_POINTS_DENOMINATOR);
}

/**
 * Preview the full VAT + TDS breakdown from the captured line amounts (the
 * provisional snapshot before issue). Returns `null` when the inputs are not yet
 * valid to compute (a discount exceeding the subtotal, or a non-integer/negative
 * amount) so the caller can render a "shown at issue" placeholder rather than a
 * wrong number — the same forgiving posture the API's DRAFT preview takes (it
 * omits the breakdown rather than 500ing on a not-yet-valid draft).
 *
 * This mirrors the API's `computeInvoiceTax` arithmetic exactly; see that file
 * for the worked examples and the anti-tamper reasoning.
 */
export function computeInvoiceTaxPreview(input: {
  lineAmountsPaisa: number[];
  discountPaisa?: number | null;
  serviceType: InvoiceServiceType;
}): InvoiceTaxPreview | null {
  let subtotalPaisa = 0;
  for (const amount of input.lineAmountsPaisa) {
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    subtotalPaisa += amount;
  }
  if (!Number.isSafeInteger(subtotalPaisa)) return null;

  const discountPaisa = input.discountPaisa ?? 0;
  if (!Number.isSafeInteger(discountPaisa) || discountPaisa < 0) return null;
  // A discount larger than the bill is rejected, not clamped (the API invariant:
  // a non-negative taxable base) — preview as "not yet valid".
  if (discountPaisa > subtotalPaisa) return null;

  const taxablePaisa = subtotalPaisa - discountPaisa;

  const vatRateBp = PREVIEW_VAT_RATE_BP;
  const vatPaisa = computeTaxPaisa(taxablePaisa, vatRateBp);
  const grossPaisa = taxablePaisa + vatPaisa;

  const tdsRateBp = PREVIEW_TDS_RATE_BP[input.serviceType];
  const tdsPaisa = computeTaxPaisa(taxablePaisa, tdsRateBp);
  const netReceivablePaisa = grossPaisa - tdsPaisa;

  return {
    subtotalPaisa,
    discountPaisa,
    taxablePaisa,
    vatRateBp,
    vatPaisa,
    grossPaisa,
    tdsRateBp,
    tdsPaisa,
    netReceivablePaisa,
    serviceType: input.serviceType,
  };
}

/**
 * Render a basis-point rate as a human percent string for the breakdown labels
 * (1300 → "13%", 150 → "1.5%", 250 → "2.5%"). Display-only; trims trailing
 * zeros so a whole percent has no ".0". Mirrors the API PDF renderer's
 * `formatRateBpAsPercent`.
 */
export function formatRateBpPercent(rateBp: number | null | undefined): string {
  if (rateBp === null || rateBp === undefined || !Number.isFinite(rateBp)) return "—";
  const percent = rateBp / 100;
  // Up to two decimals, trailing zeros stripped: 13 → "13", 1.5 → "1.5".
  return `${Number(percent.toFixed(2))}%`;
}
