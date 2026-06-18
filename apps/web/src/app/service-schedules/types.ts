import type {
  ServiceIntervalTypeName,
  ServiceScheduleStatusName,
} from "@/lib/service-schedules-schema";

// Web-side view of the API's ServiceSchedule row (ADR-0037 B3 / B5). Mirrors the
// Prisma model (apps/api/prisma/schema.prisma, model ServiceSchedule) at the
// field level. Dates arrive as ISO strings over the JSON wire, so they are
// typed as `string` here, not `Date`; meter anchors are integers in their minor
// units (km / tenths-of-an-hour) or null.
//
// Both the list and detail endpoints return this exact bare shape — the API
// does NOT nest the owning Vehicle (the controller's return type is the bare
// `ServiceSchedule`). To render the vehicle's REGISTRATION (and to classify the
// schedule's due/overdue state, which needs the vehicle's current meter
// reading), the list/detail pages resolve it with a separate fetch against the
// vehicles API and map by id — the same enrichment the Geofences pages use for
// customer names. Promoting to a shared @fleetco/shared package is deferred
// until a second app needs the type, the same calculus as the other web
// `types.ts` modules.
//
// This shape is structurally assignable to lib/maintenance.ts's
// `ServiceScheduleAnchor` (the due/overdue classifier input), so a row can be
// passed straight to `serviceScheduleState` / `nextDueForSchedule`.
//
// The interval-type / status unions are re-exported from lib/service-schedules-
// schema (the single source of truth for the web side) so a page can import the
// row type and the unions from one module.
export type { ServiceIntervalTypeName, ServiceScheduleStatusName };

export interface ServiceSchedule {
  id: string;
  vehicleId: string;
  name: string;
  description: string | null;
  intervalType: ServiceIntervalTypeName;
  intervalValue: number;
  status: ServiceScheduleStatusName;
  lastServiceAt: string;
  lastServiceOdometerKm: number | null;
  lastServiceEngineHours: number | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

// The shared `{ items, total, skip, take, sortBy, sortDir }` list envelope the
// API echoes back (apps/api ServiceSchedulesListResponse). sortBy is the
// whitelist of sortable columns; sortDir the direction.
export interface ServiceSchedulesListResponse {
  items: ServiceSchedule[];
  total: number;
  skip: number;
  take: number;
  sortBy: "name" | "createdAt";
  sortDir: "asc" | "desc";
}
