import { Injectable } from "@nestjs/common";

import { env } from "../../config/env";

/**
 * FleetCo's OWN supplier tax-identity config for invoicing (Program D /
 * ADR-0039 commitment 9). The supplier PAN/VAT number is the SELLER's tax
 * identity printed on every tax invoice — distinct from the buyer's
 * Customer.panNumber. It is OPERATOR-SUPPLIED (env INVOICE_SUPPLIER_PAN), empty
 * until the operator fills it (exactly like RESEND_API_KEY / the future R2
 * creds), and is NEVER a hardcoded/fabricated PAN.
 *
 * Wrapped behind this injectable (rather than reading `env` inline in the issue
 * flow) so the issue precondition is testable: a test provides a stub returning
 * a PAN for the happy path, or `null` to prove the "supplier PAN not configured"
 * refusal — the same wrap-the-config discipline ResendMailer uses for its key.
 *
 * ⚠️ PROPOSED / operator-supplied — the supplier PAN and the full IRD-required
 * invoice field set remain operator/accountant-verify before real billing
 * (ADR-0039 c9).
 */
@Injectable()
export class InvoiceSettingsService {
  /**
   * FleetCo's supplier PAN/VAT number, or `null` when not configured. Trimmed;
   * an empty / whitespace-only value reads as `null` (not configured) so the
   * issue flow refuses rather than printing a blank PAN.
   */
  getSupplierPan(): string | null {
    const pan = env.INVOICE_SUPPLIER_PAN;
    return pan !== undefined && pan.trim() !== "" ? pan.trim() : null;
  }

  /**
   * FleetCo's supplier (seller) NAME printed on the invoice header, beside the
   * PAN. Operator-supplied via INVOICE_SUPPLIER_NAME but, unlike the PAN, it falls
   * back to "FleetCo" (the company this software serves per CLAUDE.md — a known
   * name, not a fabrication) so a missing name never blocks issue. Only the PAN is
   * a hard precondition (it is the tax-legal identity that must never be faked).
   */
  getSupplierName(): string {
    const name = env.INVOICE_SUPPLIER_NAME;
    return name !== undefined && name.trim() !== "" ? name.trim() : "FleetCo";
  }
}
