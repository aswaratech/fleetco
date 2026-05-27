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

import { JOB_STATUS_OPTIONS } from "./types";

// Filter toolbar for /jobs. Client island so the shadcn Select
// (Radix-portal-backed) can manage open/close state and keyboard
// navigation; the surrounding page stays a Server Component that owns
// the data fetch.
//
// State lives in URL searchParams (not component state) so the page is
// bookmarkable/shareable with filters applied, the back button restores
// the previous filter set, and the server fetch uses the same
// authoritative source as the UI. Mirrors apps/web/src/app/customers/
// customers-filters.tsx exactly — one filter dimension (`status`), the
// `__all__` sentinel (Radix Select disallows empty-string), `skip=0`
// reset on filter change, `useTransition` for responsiveness.
//
// The `customerId` filter the API supports is intentionally NOT exposed
// in this toolbar: it's set by a future "jobs for this customer" link
// on the Customer detail page (the page narrows transparently and the
// breadcrumb describes the scope), the same way the Trips list treats
// vehicleId / driverId.

const ALL = "__all__";

export interface JobsFiltersProps {
  status: string | undefined;
}

export function JobsFilters({ status }: JobsFiltersProps): React.ReactElement {
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
    // Reset to page 0 on filter change so a user on page 3 of the
    // unfiltered list who narrows to a status with few matches doesn't
    // land on an empty page.
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/jobs?${qs}` : "/jobs");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="jobs-filter-status" className="text-text-muted text-xs font-medium">
          Status
        </label>
        <Select value={status ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="jobs-filter-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {JOB_STATUS_OPTIONS.map((opt) => (
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
