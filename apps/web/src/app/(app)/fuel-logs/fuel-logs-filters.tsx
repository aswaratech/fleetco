"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { NepaliDatePicker } from "@/components/nepali-date-picker";

// Filter toolbar for /fuel-logs. Client island so the date inputs can
// debounce-push URL changes inside a useTransition; the surrounding
// page stays a Server Component that owns the data fetch.
//
// State lives in URL searchParams (not component state) so the page is
// bookmarkable/shareable with filters applied, the back button restores
// the previous filter set, and the server fetch uses the same
// authoritative source as the UI. Mirrors apps/web/src/app/jobs/
// jobs-filters.tsx in shape, but exposes startDate / endDate instead
// of a status select — Fuel logs have no status column; the natural
// "narrow this ledger" verb is "show fills between these dates".
//
// The `vehicleId` / `tripId` filters the API supports are intentionally
// NOT exposed in this toolbar: they're set by future deep-links from
// the Vehicle detail page ("Fuel for this vehicle") and the Trip
// detail page ("Fuel logged on this trip"), the same way the Trips
// list treats vehicleId / driverId and the Jobs list treats customerId.
// When those deep-links land, the page reads the cuid from URL and
// renders a "Filtered to <vehicle reg>" chip above the table; this
// island stays unchanged.

export interface FuelLogsFiltersProps {
  startDate: string | undefined;
  endDate: string | undefined;
}

export function FuelLogsFilters({ startDate, endDate }: FuelLogsFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "startDate" | "endDate", value: string): void {
    const next = new URLSearchParams(params.toString());
    const trimmed = value.trim();
    if (trimmed === "") {
      next.delete(key);
    } else {
      next.set(key, trimmed);
    }
    // Reset to page 0 on filter change so a user on page 3 of the
    // unfiltered list who narrows to a date range with few matches
    // doesn't land on an empty page.
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/fuel-logs?${qs}` : "/fuel-logs");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="fuel-logs-filter-start" className="text-text-muted text-xs font-medium">
          From
        </label>
        <NepaliDatePicker
          id="fuel-logs-filter-start"
          className="w-56"
          value={startDate || null}
          onChange={(iso) => setParam("startDate", iso ?? "")}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="fuel-logs-filter-end" className="text-text-muted text-xs font-medium">
          To
        </label>
        <NepaliDatePicker
          id="fuel-logs-filter-end"
          className="w-56"
          value={endDate || null}
          onChange={(iso) => setParam("endDate", iso ?? "")}
        />
      </div>
    </div>
  );
}
