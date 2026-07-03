"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { NepaliDatePicker } from "@/components/nepali-date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Filter toolbar for /agent/activity (DESIGN.md §"Agent activity"): a status
// Select, a tool exact-match input, and a From/To BS date-picker pair. State
// lives in URL searchParams (bookmarkable, back-button-restorable, the same
// authoritative source the server fetch reads) — the notification-logs /
// per-vehicle-cost filter idioms combined. Every change resets `skip` so
// narrowing never lands on an empty page.
//
// The tool filter commits on Enter/blur (not per keystroke): the API matches
// exactly, and the ADMIN knows the snake_case names from the action cards; an
// unknown name simply returns zero rows, never a 400 (the open-string rule).

const ALL = "__all__";

// The three loop-written statuses (agent.service.ts); the API filter stays an
// open string, so this list is a UI affordance, not a contract.
const STATUS_OPTIONS = ["succeeded", "failed", "denied"] as const;

export interface ActivityFiltersProps {
  status: string | undefined;
  toolName: string | undefined;
  startDate: string | undefined;
  endDate: string | undefined;
}

export function ActivityFilters({
  status,
  toolName,
  startDate,
  endDate,
}: ActivityFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [toolDraft, setToolDraft] = useState(toolName ?? "");

  function setParam(key: "status" | "toolName" | "startDate" | "endDate", value: string): void {
    const next = new URLSearchParams(params.toString());
    const trimmed = value.trim();
    if (trimmed === "" || trimmed === ALL) {
      next.delete(key);
    } else {
      next.set(key, trimmed);
    }
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/agent/activity?${qs}` : "/agent/activity");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label htmlFor="activity-filter-status" className="text-text-muted text-xs font-medium">
          Status
        </label>
        <Select value={status ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="activity-filter-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUS_OPTIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="activity-filter-tool" className="text-text-muted text-xs font-medium">
          Tool
        </label>
        <Input
          id="activity-filter-tool"
          className="w-56 font-mono text-xs"
          placeholder="e.g. create_vehicle"
          value={toolDraft}
          onChange={(event) => setToolDraft(event.target.value)}
          onBlur={() => setParam("toolName", toolDraft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setParam("toolName", toolDraft);
            }
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="activity-filter-from" className="text-text-muted text-xs font-medium">
          From
        </label>
        <NepaliDatePicker
          id="activity-filter-from"
          className="w-56"
          value={startDate || null}
          onChange={(iso) => setParam("startDate", iso ?? "")}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="activity-filter-to" className="text-text-muted text-xs font-medium">
          To
        </label>
        <NepaliDatePicker
          id="activity-filter-to"
          className="w-56"
          value={endDate || null}
          onChange={(iso) => setParam("endDate", iso ?? "")}
        />
      </div>
    </div>
  );
}
