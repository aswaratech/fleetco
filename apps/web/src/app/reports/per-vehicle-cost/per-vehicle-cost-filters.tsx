"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Input } from "@/components/ui/input";

// Filter toolbar for /reports/per-vehicle-cost. Client island so the
// date inputs can debounce-push URL changes inside a useTransition;
// the surrounding page stays a Server Component that owns the data
// fetch.
//
// State lives in URL searchParams (not component state) so the page
// is bookmarkable/shareable with filters applied, the back button
// restores the previous filter set, and the server fetch uses the
// same authoritative source as the UI. Mirrors apps/web/src/app/
// expense-logs/expense-logs-filters.tsx in shape, with one extra
// control: a vehicle select that narrows the per-vehicle rows to a
// single vehicle's bucket (the company-level block is independent
// of this filter — see the wire contract docs in ReportsService).
//
// The vehicle picker renders a select over the active vehicles the
// server pre-fetched; the operator can scroll/search-by-keystroke in
// the native select. A future iter that lands the cross-page combobox
// component can swap this for that.

export interface PerVehicleCostFiltersProps {
  from: string;
  to: string;
  vehicleId: string;
  vehicleOptions: { id: string; registrationNumber: string }[];
}

export function PerVehicleCostFilters({
  from,
  to,
  vehicleId,
  vehicleOptions,
}: PerVehicleCostFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "from" | "to" | "vehicleId", value: string): void {
    const next = new URLSearchParams(params.toString());
    const trimmed = value.trim();
    if (trimmed === "") {
      next.delete(key);
    } else {
      next.set(key, trimmed);
    }
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/reports/per-vehicle-cost?${qs}` : "/reports/per-vehicle-cost");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="report-filter-from" className="text-text-muted text-xs font-medium">
          From
        </label>
        <Input
          id="report-filter-from"
          type="date"
          className="w-44"
          defaultValue={from}
          onBlur={(e) => {
            if ((e.target.value || "") !== from) {
              setParam("from", e.target.value);
            }
          }}
          onChange={(e) => {
            if (e.target.value.length === 10 && e.target.value !== from) {
              setParam("from", e.target.value);
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="report-filter-to" className="text-text-muted text-xs font-medium">
          To
        </label>
        <Input
          id="report-filter-to"
          type="date"
          className="w-44"
          defaultValue={to}
          onBlur={(e) => {
            if ((e.target.value || "") !== to) {
              setParam("to", e.target.value);
            }
          }}
          onChange={(e) => {
            if (e.target.value.length === 10 && e.target.value !== to) {
              setParam("to", e.target.value);
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="report-filter-vehicle" className="text-text-muted text-xs font-medium">
          Vehicle
        </label>
        <select
          id="report-filter-vehicle"
          className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-56 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
          value={vehicleId}
          onChange={(e) => {
            setParam("vehicleId", e.target.value);
          }}
        >
          <option value="">All vehicles</option>
          {vehicleOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.registrationNumber}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
