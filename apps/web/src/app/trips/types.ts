import type { Driver } from "../drivers/types";
import type { Vehicle } from "../vehicles/types";

// Web-side view of the API's Trip row. Mirrors the Prisma model in
// apps/api/prisma/schema.prisma (model Trip) at the field level; dates
// arrive as ISO strings over the JSON wire, so they are typed as
// `string` here rather than `Date` to avoid a hidden coercion surface.
// Same convention the Vehicles and Drivers web types follow.
//
// The list endpoint returns the slim projection (TripListItem below)
// and the detail endpoint returns the broader TripDetail with the
// full Vehicle + Driver objects nested. Both views live in this file
// so a future consumer doesn't have to chase the shape across files.
//
// Promoting to a shared @fleetco/shared package is deferred until a
// second app (driver app, Phase 2) needs the types.

export type TripStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

// List-endpoint item shape: the slim Vehicle + Driver projection
// (`registrationNumber` and `fullName` only). Matches the API's
// TripListItem (apps/api/src/modules/trips/trips.service.ts:LIST_SELECT).
export interface TripListItem {
  id: string;
  vehicleId: string;
  driverId: string;
  status: TripStatus;
  startedAt: string | null;
  endedAt: string | null;
  startOdometerKm: number | null;
  endOdometerKm: number | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  vehicle: {
    id: string;
    registrationNumber: string;
  };
  driver: {
    id: string;
    fullName: string;
  };
}

// Detail-endpoint shape: full Vehicle + Driver nested objects. Matches
// the API's TripDetail include shape. Reuses the Vehicle / Driver
// types from the sibling slices so a schema change to either ripples
// here automatically.
export interface TripDetail {
  id: string;
  vehicleId: string;
  driverId: string;
  status: TripStatus;
  startedAt: string | null;
  endedAt: string | null;
  startOdometerKm: number | null;
  endOdometerKm: number | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  vehicle: Vehicle;
  driver: Driver;
}

// Display-friendly enum labels. The page-level trips list uses this
// mapping and the detail page reuses it. Matches docs/glossary.md's
// prose framings of the four trip statuses (added in this iter's
// memory updates).
export const TRIP_STATUS_OPTIONS = [
  { value: "PLANNED", label: "Planned" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = Object.fromEntries(
  TRIP_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<TripStatus, string>;
