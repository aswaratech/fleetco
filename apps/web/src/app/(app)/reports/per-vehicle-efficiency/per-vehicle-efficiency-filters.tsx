"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { NepaliDatePicker } from "@/components/nepali-date-picker";

// Filter toolbar for /reports/per-vehicle-efficiency. Client island so the
// date pickers push URL changes inside a useTransition; the surrounding page
// stays a Server Component that owns the data fetch.
//
// A faithful twin of per-vehicle-cost-filters.tsx — same two date controls
// plus a single-vehicle select, same URL-searchParams state (so the surface is
// bookmarkable / shareable, the back button restores the prior filter set, and
// the server fetch reads the same authoritative source as the UI).
//
// The date controls are the shipped <NepaliDatePicker> (ADR-0032), exactly as
// the cost report adopted in B3 (commit d6983c0). The picker's value contract
// is the EXACT YYYY-MM-DD UTC-calendar-day string the API's ReportsQuerySchema
// parses, so the operator picks in the Bikram Sambat calendar while the wire
// stays ISO/AD — the kickoff's "native AD inputs" phrasing predates ADR-0032
// (it carried ADR-0031 commitment 6, which deferred the picker; ADR-0032 IS
// that now-shipped slice). DESIGN.md's controlling instruction is "exactly as
// on the cost report", which is the picker.
//
// The vehicle select renders over the vehicles the server pre-fetched; the
// company-level concept does not exist on this report (both inputs are
// vehicle-bound), so the only filter beyond the window is the single-vehicle
// narrow.

export interface PerVehicleEfficiencyFiltersProps {
  from: string;
  to: string;
  vehicleId: string;
  vehicleOptions: { id: string; registrationNumber: string }[];
}

export function PerVehicleEfficiencyFilters({
  from,
  to,
  vehicleId,
  vehicleOptions,
}: PerVehicleEfficiencyFiltersProps): React.ReactElement {
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
      router.push(qs ? `/reports/per-vehicle-efficiency?${qs}` : "/reports/per-vehicle-efficiency");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="efficiency-filter-from" className="text-text-muted text-xs font-medium">
          From
        </label>
        <NepaliDatePicker
          id="efficiency-filter-from"
          className="w-56"
          value={from || null}
          onChange={(iso) => setParam("from", iso ?? "")}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="efficiency-filter-to" className="text-text-muted text-xs font-medium">
          To
        </label>
        <NepaliDatePicker
          id="efficiency-filter-to"
          className="w-56"
          value={to || null}
          onChange={(iso) => setParam("to", iso ?? "")}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="efficiency-filter-vehicle" className="text-text-muted text-xs font-medium">
          Vehicle
        </label>
        <select
          id="efficiency-filter-vehicle"
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
