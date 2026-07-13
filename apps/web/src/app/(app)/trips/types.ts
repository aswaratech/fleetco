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

export type TripStatus =
  | "PLANNED"
  | "OFFERED"
  | "ACCEPTED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

// Haulage material (ADR-0047 c5). Mirrors the API's MaterialType Prisma enum
// (apps/api/src/modules/trips/trips.schemas.ts MATERIAL_TYPES). The form's select
// options + the zod validation list live in @/lib/trips-schema.ts; the three lists
// (this type, MATERIAL_TYPE_OPTIONS below, and the schema's MATERIAL_TYPES) move
// in lock-step, exactly as TripStatus does with TRIP_STATUS_OPTIONS.
export type MaterialType =
  | "SAND"
  | "AGGREGATE"
  | "GRAVEL"
  | "STONE"
  | "BOULDER"
  | "SOIL"
  | "BRICKS"
  | "OTHER";

// Engine-hours meter classification (ADR-0036). Mirrors the Vehicle type's
// `meterType`; re-exported here so the trip forms can type their vehicle
// pickers without importing the whole Vehicle shape.
export type VehicleMeterType = "ODOMETER_KM" | "ENGINE_HOURS" | "BOTH";

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
    // meterType (ADR-0036) — the API's trip list projects it so the driver app
    // can branch its capture; the web list does not render it but carries it.
    meterType: VehicleMeterType;
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
  // Engine-hours readings (ADR-0036), integer tenths-of-an-hour. The detail
  // endpoint returns them (the slim list projection does not). Null for a
  // km-only trip; the edit form pre-fills the hours inputs from these.
  startEngineHours: number | null;
  endEngineHours: number | null;
  notes: string | null;
  // Haulage order (ADR-0047 W2/W4). Null until the trip is dispatched (OFFERED).
  materialType: MaterialType | null;
  materialNote: string | null;
  pickupSiteId: string | null;
  dropoffSiteId: string | null;
  consigneeName: string | null;
  consigneePhone: string | null;
  expectedLoadCount: number | null;
  specialInstructions: string | null;
  docketNumber: string | null;
  // Dispatch + intra-trip milestone timestamps (ISO strings; ADR-0047 c1/c3).
  // Null until the milestone is reached.
  offeredAt: string | null;
  acceptedAt: string | null;
  arrivedPickupAt: string | null;
  loadedAt: string | null;
  arrivedDropoffAt: string | null;
  deliveredAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  vehicle: Vehicle;
  driver: Driver;
  // Pickup/drop-off Site labels — the API's DETAIL_INCLUDE projects {id, name}
  // only (the Tier-2 site contact stays off the nested Site). Null when unset.
  pickupSite: { id: string; name: string } | null;
  dropoffSite: { id: string; name: string } | null;
}

// Display-friendly enum labels. The page-level trips list uses this
// mapping and the detail page reuses it. Matches docs/glossary.md's
// prose framings of the four trip statuses (added in this iter's
// memory updates).
export const TRIP_STATUS_OPTIONS = [
  { value: "PLANNED", label: "Planned" },
  { value: "OFFERED", label: "Offered" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
] as const;

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = Object.fromEntries(
  TRIP_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<TripStatus, string>;

export type BadgeVariant = "warning" | "error" | "success" | "info" | "neutral";

// Status → Badge hue (ADR-0047 W6, DESIGN §"Trip dispatch"). Hue is recognition,
// the label is meaning: OFFERED is the actionable "awaiting the driver" amber,
// ACCEPTED the "acknowledged, not yet started" blue. Every value is one of the
// five shipped Badge variants — no new token, so the design-token-drift test
// stays green.
export const TRIP_STATUS_BADGE: Record<TripStatus, BadgeVariant> = {
  PLANNED: "neutral",
  OFFERED: "warning",
  ACCEPTED: "info",
  IN_PROGRESS: "success",
  COMPLETED: "neutral",
  CANCELLED: "error",
};

// Haulage material select options + labels (ADR-0047 c5). The trip form renders
// MATERIAL_TYPE_OPTIONS in a native <select>; the trip detail Order section
// renders MATERIAL_TYPE_LABELS. The zod validation list is the sibling
// MATERIAL_TYPES in @/lib/trips-schema.ts — keep all three in lock-step.
export const MATERIAL_TYPE_OPTIONS = [
  { value: "SAND", label: "Sand" },
  { value: "AGGREGATE", label: "Aggregate" },
  { value: "GRAVEL", label: "Gravel" },
  { value: "STONE", label: "Stone" },
  { value: "BOULDER", label: "Boulder" },
  { value: "SOIL", label: "Soil" },
  { value: "BRICKS", label: "Bricks" },
  { value: "OTHER", label: "Other" },
] as const;

export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = Object.fromEntries(
  MATERIAL_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<MaterialType, string>;
