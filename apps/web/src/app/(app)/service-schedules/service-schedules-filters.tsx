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
import { SERVICE_SCHEDULE_STATUS_OPTIONS } from "@/lib/service-schedules-schema";

// Filter toolbar for /service-schedules. Client island so the shadcn Select
// (Radix-portal-backed) can manage open/close state and keyboard navigation;
// the surrounding page stays a Server Component that owns the data fetch.
//
// State lives in URL searchParams (not component state) so the page is
// bookmarkable/shareable with filters applied, the back-button restores the
// previous filter set, and the server fetch uses the same authoritative source
// as the UI. Mirrors apps/web/src/app/geofences/geofences-filters.tsx, with two
// filter dimensions (vehicle + status). The vehicle options are passed from the
// page's vehicles fetch (the same one that resolves the table's registrations).
//
// Same `__all__` sentinel (Radix Select disallows empty-string), same `skip=0`
// reset on filter change, same useTransition.

const ALL = "__all__";

interface VehicleOption {
  id: string;
  registrationNumber: string;
}

export interface ServiceSchedulesFiltersProps {
  vehicleId: string | undefined;
  status: string | undefined;
  vehicles: VehicleOption[];
}

export function ServiceSchedulesFilters({
  vehicleId,
  status,
  vehicles,
}: ServiceSchedulesFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "vehicleId" | "status", value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    // Reset to page 0 on filter change so a user deep into an unfiltered list
    // does not land on an empty page after narrowing.
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/service-schedules?${qs}` : "/service-schedules");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="service-schedules-filter-vehicle"
          className="text-text-muted text-xs font-medium"
        >
          Vehicle
        </label>
        <Select value={vehicleId ?? ALL} onValueChange={(v) => setParam("vehicleId", v)}>
          <SelectTrigger id="service-schedules-filter-vehicle" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All vehicles</SelectItem>
            {vehicles.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.registrationNumber}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="service-schedules-filter-status"
          className="text-text-muted text-xs font-medium"
        >
          Status
        </label>
        <Select value={status ?? ALL} onValueChange={(v) => setParam("status", v)}>
          <SelectTrigger id="service-schedules-filter-status" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {SERVICE_SCHEDULE_STATUS_OPTIONS.map((opt) => (
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
