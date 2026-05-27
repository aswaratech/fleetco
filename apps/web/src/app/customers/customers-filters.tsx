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
import { CUSTOMER_STATUS_OPTIONS } from "@/lib/customers-schema";

// Filter toolbar for /customers. Client island so the shadcn Select
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
// Mirrors apps/web/src/app/drivers/drivers-filters.tsx exactly. The
// Customers surface has only one filter dimension (`status`) — there
// is no `kind` or `licenseClass` parallel — so the toolbar renders one
// Select rather than two. Same `__all__` sentinel value (Radix Select
// disallows empty-string), same `skip=0` reset on filter change, same
// `useTransition` for responsiveness.

const ALL = "__all__";

export interface CustomersFiltersProps {
  status: string | undefined;
}

export function CustomersFilters({ status }: CustomersFiltersProps): React.ReactElement {
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
    // Reset to page 0 on filter change. Without this a user on page 3
    // of an unfiltered list who narrows to a status with 4 matches
    // sees an empty page until they realize to click "1".
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/customers?${qs}` : "/customers");
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
        <label htmlFor="customers-filter-status" className="text-text-muted text-xs font-medium">
          Status
        </label>
        <Select value={status ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="customers-filter-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {CUSTOMER_STATUS_OPTIONS.map((opt) => (
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
