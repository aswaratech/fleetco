"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { DOCUMENT_TYPE_OPTIONS, INVOICE_STATUS_OPTIONS } from "./types";

// Filter toolbar for /invoices. Client island so the selects can push URL changes
// inside a useTransition; the surrounding page stays a Server Component that owns
// the data fetch.
//
// State lives in URL searchParams (not component state) so the page is
// bookmarkable/shareable with filters applied and the back button restores the
// previous filter set. Mirrors apps/web/src/app/expense-logs/expense-logs-filters.tsx
// (native <select>s over enum + a fetched-options list). Three dimensions: status,
// documentType, and customer. The customer options are fetched server-side and
// passed in (the same enrichment the Geofences list does for customer names);
// PII discipline holds — only the customer id rides the URL, resolved server-side.

export interface CustomerFilterOption {
  id: string;
  name: string;
}

export interface InvoicesFiltersProps {
  status: string | undefined;
  documentType: string | undefined;
  customerId: string | undefined;
  customers: CustomerFilterOption[];
}

const SELECT_CLASS =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-48 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]";

export function InvoicesFilters({
  status,
  documentType,
  customerId,
  customers,
}: InvoicesFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "status" | "documentType" | "customerId", value: string): void {
    const next = new URLSearchParams(params.toString());
    const trimmed = value.trim();
    if (trimmed === "") {
      next.delete(key);
    } else {
      next.set(key, trimmed);
    }
    // Reset to page 0 on filter change so a user deep in the list who narrows
    // down doesn't land on an empty page.
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/invoices?${qs}` : "/invoices");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="invoices-filter-status" className="text-text-muted text-xs font-medium">
          Status
        </label>
        <select
          id="invoices-filter-status"
          className={SELECT_CLASS}
          value={status ?? ""}
          onChange={(e) => setParam("status", e.target.value)}
        >
          <option value="">All statuses</option>
          {INVOICE_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="invoices-filter-doc-type" className="text-text-muted text-xs font-medium">
          Document type
        </label>
        <select
          id="invoices-filter-doc-type"
          className={SELECT_CLASS}
          value={documentType ?? ""}
          onChange={(e) => setParam("documentType", e.target.value)}
        >
          <option value="">All documents</option>
          {DOCUMENT_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="invoices-filter-customer" className="text-text-muted text-xs font-medium">
          Customer
        </label>
        <select
          id="invoices-filter-customer"
          className={SELECT_CLASS}
          value={customerId ?? ""}
          onChange={(e) => setParam("customerId", e.target.value)}
        >
          <option value="">All customers</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
