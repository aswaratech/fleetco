// Renewal-record display helpers (ADR-0049 F5). Mirrors the API's
// renewals.schemas.ts vocabulary: the kind union, its labels, the
// per-kind document category (the proof select's filter), and the per-kind
// expense categories (the cost select's filter) — all drift-pinned against
// the API by apps/web/test/renewals.test.ts. Pure module.

import type { DocumentCategory } from "./documents";

export type RenewalKind = "BLUEBOOK" | "INSURANCE" | "ROUTE_PERMIT";

export const RENEWAL_KINDS: readonly RenewalKind[] = ["BLUEBOOK", "INSURANCE", "ROUTE_PERMIT"];

export const RENEWAL_KIND_LABELS: Record<RenewalKind, string> = {
  BLUEBOOK: "Bluebook",
  INSURANCE: "Insurance",
  ROUTE_PERMIT: "Route permit",
};

/** The FleetDocument category a kind's proof document must carry — must
 * mirror the API's DOCUMENT_CATEGORY_FOR_KIND. */
export const DOCUMENT_CATEGORY_FOR_KIND: Record<RenewalKind, DocumentCategory> = {
  BLUEBOOK: "BLUEBOOK",
  INSURANCE: "INSURANCE",
  ROUTE_PERMIT: "ROUTE_PERMIT",
};

/** The ExpenseLog categories a kind's cost link may carry — must mirror the
 * API's EXPENSE_CATEGORIES_FOR_KIND. */
export const EXPENSE_CATEGORIES_FOR_KIND: Record<RenewalKind, readonly string[]> = {
  BLUEBOOK: ["PERMIT", "OTHER"],
  INSURANCE: ["INSURANCE"],
  ROUTE_PERMIT: ["PERMIT"],
};

export function isRenewalKind(value: string | undefined): value is RenewalKind {
  return value !== undefined && (RENEWAL_KINDS as readonly string[]).includes(value);
}

/** The renewal-history wire shape (dates as ISO strings; the linked
 * proof/cost summaries nested by the F5 list read). */
export interface RenewalListItem {
  id: string;
  kind: RenewalKind;
  previousExpiresAt: string | null;
  newExpiresAt: string;
  renewedAt: string;
  notes: string | null;
  document: { id: string; title: string } | null;
  expenseLog: { id: string; amountPaisa: number } | null;
}

export interface RenewalsListResponse {
  items: RenewalListItem[];
  total: number;
  skip: number;
  take: number;
}
