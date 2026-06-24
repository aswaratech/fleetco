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
import { SUBJECT_TYPE_FILTER_OPTIONS } from "@/lib/notification-logs";

// Filter toolbar for /notification-logs. Client island so the shadcn Select
// (Radix-portal-backed) can manage open/close state and keyboard navigation; the
// surrounding page remains a Server Component that owns the data fetch.
//
// State lives in URL searchParams (not component state) so the page is
// bookmarkable, the back button restores the prior filter, and the server fetch
// always uses the same authoritative source the UI does. Mirrors
// apps/web/src/app/customers/customers-filters.tsx exactly — one filter
// dimension (subjectType), the same `__all__` sentinel (Radix Select disallows
// empty-string), the same skip=0 reset on filter change, the same useTransition.
//
// The API also accepts reminderKind / state / date-range filters, but the v1
// audit view surfaces only the primary subjectType axis ("compliance vs
// maintenance reminders") to keep the toolbar focused; the others stay
// URL-reachable for a power user.

const ALL = "__all__";

export interface NotificationLogsFiltersProps {
  subjectType: string | undefined;
}

export function NotificationLogsFilters({
  subjectType,
}: NotificationLogsFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "subjectType", value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    // Reset to page 0 on filter change so a user deep in the pagination of an
    // unfiltered list does not land on an empty page after narrowing.
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/notification-logs?${qs}` : "/notification-logs");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="notification-logs-filter-subject"
          className="text-text-muted text-xs font-medium"
        >
          Reminder type
        </label>
        <Select value={subjectType ?? ALL} onValueChange={(v) => setParam("subjectType", v)}>
          <SelectTrigger id="notification-logs-filter-subject" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All reminder types</SelectItem>
            {SUBJECT_TYPE_FILTER_OPTIONS.map((opt) => (
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
