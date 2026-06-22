"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DRIVER_STATUS_OPTIONS, LICENSE_CLASS_OPTIONS } from "@/lib/drivers-schema";

// Filter toolbar for /drivers. Client island so the shadcn Select
// (Radix-portal-backed) can manage open/close state and keyboard
// navigation; the surrounding page remains a Server Component that
// owns the data fetch.
//
// State lives in URL searchParams (not in component state) so:
//   - the page is bookmarkable / shareable with filters applied;
//   - back-button restores the previous filter set without React state
//     reconciliation;
//   - the server-rendered fetch always uses the same authoritative
//     source the UI does (no client/server filter drift).
//
// The convention mirrors apps/web/src/app/vehicles/vehicles-filters.tsx
// exactly so the two surfaces behave identically — same `__all__`
// sentinel value (Radix Select disallows empty-string), same `skip=0`
// reset on filter change, same `useTransition` for responsiveness. The
// only differences are the filter dimensions (status + licenseClass
// here vs status + kind on Vehicles).

const ALL = "__all__";

export interface DriversFiltersProps {
  status: string | undefined;
  licenseClass: string | undefined;
}

export function DriversFilters({ status, licenseClass }: DriversFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "status" | "licenseClass", value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    // Reset to page 0 on filter change. Without this a user on page 3
    // of an unfiltered list who narrows to a class with 4 matches sees
    // an empty page until they realize to click "1".
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/drivers?${qs}` : "/drivers");
    });
  }

  return (
    <div
      className="flex flex-wrap items-end gap-3"
      // aria-busy reflects the in-flight server re-render so screen
      // readers announce loading state on filter change. The visual
      // indication is the page's loading.tsx skeleton that Next.js
      // renders during the transition.
      aria-busy={pending}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="drivers-filter-status" className="text-text-muted text-xs font-medium">
          Status
        </label>
        <Select value={status ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="drivers-filter-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {DRIVER_STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label
          htmlFor="drivers-filter-license-class"
          className="text-text-muted text-xs font-medium"
        >
          License class
        </label>
        <Select value={licenseClass ?? ALL} onValueChange={(v) => setParam("licenseClass", v)}>
          <SelectTrigger id="drivers-filter-license-class" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All license classes</SelectItem>
            {LICENSE_CLASS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
