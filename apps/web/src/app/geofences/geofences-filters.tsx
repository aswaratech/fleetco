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
import { GEOFENCE_TYPE_OPTIONS } from "@/lib/geofences-schema";

// Filter toolbar for /geofences. Client island so the shadcn Select
// (Radix-portal-backed) can manage open/close state and keyboard
// navigation; the surrounding page remains a Server Component that owns the
// data fetch.
//
// State lives in URL searchParams (not component state) so the page is
// bookmarkable / shareable with filters applied, the back-button restores
// the previous filter set, and the server-rendered fetch always uses the
// same authoritative source the UI does.
//
// Mirrors apps/web/src/app/customers/customers-filters.tsx exactly. The
// Geofences surface has one filter dimension (`type`), so the toolbar
// renders one Select. Same `__all__` sentinel (Radix Select disallows
// empty-string), same `skip=0` reset on filter change, same useTransition.

const ALL = "__all__";

export interface GeofencesFiltersProps {
  type: string | undefined;
}

export function GeofencesFilters({ type }: GeofencesFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "type", value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    // Reset to page 0 on filter change so a user deep into an unfiltered
    // list does not land on an empty page after narrowing.
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/geofences?${qs}` : "/geofences");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="geofences-filter-type" className="text-text-muted text-xs font-medium">
          Type
        </label>
        <Select value={type ?? ALL} onValueChange={(v) => setParam("type", v)}>
          <SelectTrigger id="geofences-filter-type" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {GEOFENCE_TYPE_OPTIONS.map((opt) => (
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
