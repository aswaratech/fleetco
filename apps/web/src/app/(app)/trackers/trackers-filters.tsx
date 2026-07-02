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
import { TRACKER_STATUS_OPTIONS } from "@/lib/trackers-schema";

// Filter toolbar for /trackers. Client island so the shadcn Select
// (Radix-portal-backed) can manage open/close state; the surrounding page
// remains a Server Component that owns the data fetch. State lives in URL
// searchParams (bookmarkable, back-button-friendly, single authoritative
// source for the server fetch).
//
// Mirrors apps/web/src/app/(app)/geofences/geofences-filters.tsx exactly.
// The Trackers surface has one toolbar filter dimension (`status`); the
// same `__all__` sentinel (Radix Select disallows empty-string), the same
// `skip=0` reset on filter change, the same useTransition.

const ALL = "__all__";

export interface TrackersFiltersProps {
  status: string | undefined;
}

export function TrackersFilters({ status }: TrackersFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "status", value: string): void {
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
      router.push(qs ? `/trackers?${qs}` : "/trackers");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="trackers-filter-status" className="text-text-muted text-xs font-medium">
          Status
        </label>
        <Select value={status ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="trackers-filter-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {TRACKER_STATUS_OPTIONS.map((opt) => (
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
