// Invoice / credit-note number formatting (Program D / ADR-0039 commitment 4).
//
// PURE — a document series + a BS fiscal-year label + a sequence in, the
// formatted number out. No DB, no I/O, no Prisma runtime (the DocumentType
// import is type-only — the prefix map is keyed by the string-literal union, not
// the runtime enum). The InvoiceNumberingService owns WHEN the sequence advances
// (the gapless counter); this file owns only HOW the parts render, so the format
// is pinned by a focused unit test and lives in exactly one place.
import type { DocumentType } from "@prisma/client";

// The zero-padded width of the sequence portion (NNNNN). 5 digits = 99,999
// documents per (series, fiscal year) — well above a heavy-fleet operator's
// annual volume, and matching JobsService.nextJobNumber's 5-digit padding.
const SEQUENCE_PAD_WIDTH = 5;

// The number prefix per document series (ADR-0039 c5): an INVOICE and a
// CREDIT_NOTE carry visibly distinct, INDEPENDENTLY-sequenced numbers (CRN
// matches the existing credit-note seed in invoices.service.test.ts). The
// `Record<DocumentType, string>` type is the drift guard: a future DocumentType
// member becomes a compile error here until its prefix is supplied.
const DOCUMENT_PREFIX: Record<DocumentType, string> = {
  INVOICE: "INV",
  CREDIT_NOTE: "CRN",
};

/**
 * Format an invoice / credit-note number from its document series, BS
 * fiscal-year label, and sequence value (ADR-0039 c4):
 *
 *   formatInvoiceNumber("INVOICE", "2082-83", 1)      → "INV-2082-83-00001"
 *   formatInvoiceNumber("CREDIT_NOTE", "2082-83", 1)  → "CRN-2082-83-00001"
 *
 * The sequence is zero-padded to 5 digits; a value past 99,999 still renders (it
 * simply widens) so the format degrades rather than silently truncating.
 */
export function formatInvoiceNumber(
  documentType: DocumentType,
  fiscalYearLabel: string,
  sequence: number,
): string {
  const prefix = DOCUMENT_PREFIX[documentType];
  return `${prefix}-${fiscalYearLabel}-${String(sequence).padStart(SEQUENCE_PAD_WIDTH, "0")}`;
}
