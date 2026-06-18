import type { Customer } from "../customers/types";

// Web-side view of the API's Invoice / InvoiceLine rows (Program D / ADR-0039).
// Mirrors the Prisma models in apps/api/prisma/schema.prisma (model Invoice /
// InvoiceLine) and the API's LIST_SELECT / DETAIL_INCLUDE shapes
// (apps/api/src/modules/invoices/invoices.service.ts). Dates + money arrive over
// the JSON wire as ISO strings / integer paisa, so dates are typed `string` and
// money `number` (integer paisa) here — the same convention as the Jobs /
// Customers web types. Promoting to a shared @fleetco/shared package is deferred
// until a second app needs the type.
//
// The list endpoint returns the SLIM projection (InvoiceListItem — the customer
// reduced to `{ id, name }`, only the columns the list table renders); the detail
// endpoint returns InvoiceDetail with the full nested Customer + the optional Job
// + the owned lines, so the detail page can render every field and deep-link back
// to /customers/<id> and /jobs/<id>.
//
// The frozen tax columns (subtotalPaisa … netReceivablePaisa, vatRateBp,
// tdsRateBp) + `number` + `issuedAt` + `pdfR2Key` are NULLABLE until issue
// (ADR-0039 c3/c5): a DRAFT row carries nulls — expected, not a bug. The web
// surface renders the FROZEN columns for an ISSUED invoice (never a recompute,
// the anti-tamper freeze) and a provisional client preview for a DRAFT.

export type InvoiceStatus = "DRAFT" | "ISSUED" | "CANCELLED";
export type DocumentType = "INVOICE" | "CREDIT_NOTE";
export type InvoiceServiceType = "VEHICLE_HIRE" | "GOODS_TRANSPORT";

// A billable line (apps/api InvoiceLine). `lineAmountPaisa` is derived server-side
// (quantity * unitPricePaisa); the web never sets it.
export interface InvoiceLine {
  id: string;
  invoiceId: string;
  tripId: string | null;
  jobId: string | null;
  description: string;
  quantity: number;
  unitPricePaisa: number;
  lineAmountPaisa: number;
  createdAt: string;
  updatedAt: string;
}

// The optional provenance Job nested on a detail invoice (DETAIL_INCLUDE
// `job: true` — a plain Job row, no nested customer). Only the fields the detail
// page renders / deep-links are typed.
export interface InvoiceJob {
  id: string;
  jobNumber: string;
  description: string;
  status: string;
}

// List-endpoint item — the API's LIST_SELECT. The slim customer projection
// (`id` + `name`) + the money/status columns the list table shows. All frozen
// money columns + `number` + `issuedAt` are nullable until issue.
export interface InvoiceListItem {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  documentType: DocumentType;
  customerId: string;
  jobId: string | null;
  grossPaisa: number | null;
  netReceivablePaisa: number | null;
  issuedAt: string | null;
  createdAt: string;
  createdById: string;
  customer: {
    id: string;
    name: string;
  };
}

// Detail-endpoint shape — the API's DETAIL_INCLUDE: full nested Customer (always
// present; the FK is NOT NULL), the optional nested Job, and the owned lines
// (oldest-first). Reuses the Customer type from the sibling slice so a Customer
// schema change ripples here automatically.
export interface InvoiceDetail {
  id: string;
  number: string | null;
  status: InvoiceStatus;
  documentType: DocumentType;
  customerId: string;
  jobId: string | null;
  originalInvoiceId: string | null;
  serviceType: InvoiceServiceType | null;
  // Frozen tax snapshot — NULL until issue.
  subtotalPaisa: number | null;
  discountPaisa: number | null;
  vatRateBp: number | null;
  vatPaisa: number | null;
  grossPaisa: number | null;
  tdsRateBp: number | null;
  tdsPaisa: number | null;
  netReceivablePaisa: number | null;
  issuedAt: string | null;
  pdfR2Key: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  customer: Customer;
  job: InvoiceJob | null;
  lines: InvoiceLine[];
}

// ---------------------------------------------------------------------------
// Display labels + Badge-variant maps. The Badge variants are existing
// `color.status.*` tokens only (DESIGN.md §"Status badges") — NO new design
// token, so the design-token-drift test stays green:
//   status     DRAFT → neutral (working state), ISSUED → success (committed /
//              valid), CANCELLED → error (voided).
//   documentType INVOICE → neutral (the common case), CREDIT_NOTE → info (the
//              rare corrective document — DESIGN.md "blue = informational, rare").
// `BadgeVariant` mirrors the badge.tsx variant union without importing the
// component into this server-shared types module.
// ---------------------------------------------------------------------------

export type BadgeVariant = "warning" | "error" | "success" | "info" | "neutral";

export const INVOICE_STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft" },
  { value: "ISSUED", label: "Issued" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  DRAFT: "Draft",
  ISSUED: "Issued",
  CANCELLED: "Cancelled",
};

export const INVOICE_STATUS_BADGE: Record<InvoiceStatus, BadgeVariant> = {
  DRAFT: "neutral",
  ISSUED: "success",
  CANCELLED: "error",
};

export const DOCUMENT_TYPE_OPTIONS = [
  { value: "INVOICE", label: "Invoice" },
  { value: "CREDIT_NOTE", label: "Credit note" },
] as const;

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
};

export const DOCUMENT_TYPE_BADGE: Record<DocumentType, BadgeVariant> = {
  INVOICE: "neutral",
  CREDIT_NOTE: "info",
};

// Service type selects the (PROPOSED, operator/accountant-verify — ADR-0039 c9)
// TDS rate; required before an invoice can be issued.
export const INVOICE_SERVICE_TYPE_OPTIONS = [
  { value: "VEHICLE_HIRE", label: "Vehicle / equipment hire (TDS 1.5%)" },
  { value: "GOODS_TRANSPORT", label: "Goods transport (TDS 2.5%)" },
] as const;

export const INVOICE_SERVICE_TYPE_LABELS: Record<InvoiceServiceType, string> = {
  VEHICLE_HIRE: "Vehicle / equipment hire",
  GOODS_TRANSPORT: "Goods transport",
};
