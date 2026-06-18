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

// Filter toolbar for /service-records. Client island (shadcn Select is
// Radix-portal-backed); the surrounding page stays a Server Component owning the
// fetch. State lives in URL searchParams so the page is bookmarkable and the
// back-button restores filters. Mirrors the service-schedules filters, with the
// vehicle + schedule dimensions the API supports. The schedule options are
// pre-labelled with their vehicle registration by the page (which holds both
// maps) so like-named schedules on different vehicles are distinguishable.

const ALL = "__all__";

interface VehicleOption {
  id: string;
  registrationNumber: string;
}

interface ScheduleOption {
  id: string;
  label: string;
}

export interface ServiceRecordsFiltersProps {
  vehicleId: string | undefined;
  serviceScheduleId: string | undefined;
  vehicles: VehicleOption[];
  schedules: ScheduleOption[];
}

export function ServiceRecordsFilters({
  vehicleId,
  serviceScheduleId,
  vehicles,
  schedules,
}: ServiceRecordsFiltersProps): React.ReactElement {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(key: "vehicleId" | "serviceScheduleId", value: string): void {
    const next = new URLSearchParams(params.toString());
    if (value === ALL) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    next.delete("skip");
    startTransition(() => {
      const qs = next.toString();
      router.push(qs ? `/service-records?${qs}` : "/service-records");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="service-records-filter-vehicle"
          className="text-text-muted text-xs font-medium"
        >
          Vehicle
        </label>
        <Select value={vehicleId ?? ALL} onValueChange={(v) => setParam("vehicleId", v)}>
          <SelectTrigger id="service-records-filter-vehicle" className="w-56">
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
          htmlFor="service-records-filter-schedule"
          className="text-text-muted text-xs font-medium"
        >
          Schedule
        </label>
        <Select
          value={serviceScheduleId ?? ALL}
          onValueChange={(v) => setParam("serviceScheduleId", v)}
        >
          <SelectTrigger id="service-records-filter-schedule" className="w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All schedules</SelectItem>
            {schedules.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
