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
import { VEHICLE_KIND_OPTIONS, VEHICLE_STATUS_OPTIONS } from "@/lib/vehicles-schema";

// Filter toolbar for /vehicles. Client island so the shadcn Select
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
// When the user picks a status or kind the component computes the new
// query string, resets `skip=0` (a filter change invalidates the
// previous page offset; staying on "page 7" of a freshly filtered
// result set would frequently land on an empty page), and pushes the
// new URL. `useTransition` keeps the trigger responsive while Next.js
// re-fetches the server component.
//
// The Select trigger uses the special value `"__all__"` as the
// "no filter" option because Radix Select disallows empty-string
// values (it conflates them with the placeholder state). A small
// shim translates `__all__` ↔ "filter removed from URL".

const ALL = "__all__";

export interface VehiclesFiltersProps {
  status: string | undefined;
  kind: string | undefined;
}

export function VehiclesFilters({ status, kind }: VehiclesFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "status" | "kind", value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    // Reset to page 0 on filter change. Without this a user on page 3
    // of an unfiltered list who narrows to a kind with 4 matches sees
    // an empty page until they realize to click "1".
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/vehicles?${qs}` : "/vehicles");
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
        <label htmlFor="vehicles-filter-status" className="text-text-muted text-xs font-medium">
          Status
        </label>
        <Select value={status ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="vehicles-filter-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {VEHICLE_STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="vehicles-filter-kind" className="text-text-muted text-xs font-medium">
          Kind
        </label>
        <Select value={kind ?? ALL} onValueChange={(v) => setParam("kind", v)}>
          <SelectTrigger id="vehicles-filter-kind" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All kinds</SelectItem>
            {VEHICLE_KIND_OPTIONS.map((opt) => (
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
