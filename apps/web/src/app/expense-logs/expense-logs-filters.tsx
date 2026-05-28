"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Input } from "@/components/ui/input";

import { EXPENSE_CATEGORY_OPTIONS } from "./types";

// Filter toolbar for /expense-logs. Client island so the date inputs
// can debounce-push URL changes inside a useTransition; the surrounding
// page stays a Server Component that owns the data fetch.
//
// State lives in URL searchParams (not component state) so the page is
// bookmarkable/shareable with filters applied, the back button restores
// the previous filter set, and the server fetch uses the same
// authoritative source as the UI. Mirrors apps/web/src/app/fuel-logs/
// fuel-logs-filters.tsx in shape, with the additional `category`
// native select over the eight-value ExpenseCategory enum (the schema
// distinguishes a maintenance fill-up from a fine from a toll booth;
// the category filter is the most direct narrow).
//
// The `vehicleId` / `tripId` filters the API supports are NOT exposed
// in this toolbar today: they're set by future deep-links from the
// Vehicle detail page ("Expenses for this vehicle") and the Trip
// detail page ("Expenses logged on this trip"), the same way the
// Trips list treats vehicleId / driverId and the Jobs list treats
// customerId. The iter-22 write path will introduce a vehicle picker
// against active vehicles; surfacing a picker here in the read-only
// iter would be premature.

export interface ExpenseLogsFiltersProps {
  startDate: string | undefined;
  endDate: string | undefined;
  category: string | undefined;
}

export function ExpenseLogsFilters({
  startDate,
  endDate,
  category,
}: ExpenseLogsFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "startDate" | "endDate" | "category", value: string): void {
    const next = new URLSearchParams(params.toString());
    const trimmed = value.trim();
    if (trimmed === "") {
      next.delete(key);
    } else {
      next.set(key, trimmed);
    }
    // Reset to page 0 on filter change so a user on page 3 of the
    // unfiltered list who narrows down doesn't land on an empty page.
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/expense-logs?${qs}` : "/expense-logs");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="expense-logs-filter-category"
          className="text-text-muted text-xs font-medium"
        >
          Category
        </label>
        <select
          id="expense-logs-filter-category"
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-44 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
          value={category ?? ""}
          onChange={(e) => {
            setParam("category", e.target.value);
          }}
        >
          <option value="">All categories</option>
          {EXPENSE_CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="expense-logs-filter-start" className="text-text-muted text-xs font-medium">
          From
        </label>
        <Input
          id="expense-logs-filter-start"
          type="date"
          className="w-44"
          defaultValue={startDate ?? ""}
          onBlur={(e) => {
            if ((e.target.value || "") !== (startDate ?? "")) {
              setParam("startDate", e.target.value);
            }
          }}
          onChange={(e) => {
            // Native date input commits on every typed character; the
            // commit lands once the value is a complete date.
            if (e.target.value.length === 10 && e.target.value !== (startDate ?? "")) {
              setParam("startDate", e.target.value);
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="expense-logs-filter-end" className="text-text-muted text-xs font-medium">
          To
        </label>
        <Input
          id="expense-logs-filter-end"
          type="date"
          className="w-44"
          defaultValue={endDate ?? ""}
          onBlur={(e) => {
            if ((e.target.value || "") !== (endDate ?? "")) {
              setParam("endDate", e.target.value);
            }
          }}
          onChange={(e) => {
            if (e.target.value.length === 10 && e.target.value !== (endDate ?? "")) {
              setParam("endDate", e.target.value);
            }
          }}
        />
      </div>
    </div>
  );
}
