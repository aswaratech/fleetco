// Service-schedule due/overdue classification for the web. The implementation
// now lives in @fleetco/shared (ADR-0038 commitment 6 — the load-bearing drift
// guard) so the web BADGE (Vehicle detail + the dashboard "services due"
// roll-up) and the apps/api reminder SCAN classify a schedule from ONE copy that
// cannot drift. This module re-exports the shared symbols under the SAME
// `@/lib/maintenance` path the web has always used, so every existing importer
// (vehicles/[id]/page.tsx, service-schedules/due/page.tsx,
// service-schedules/[id]/page.tsx, lib/dashboard.ts, and the maintenance.test.ts
// suite) is unchanged. See @fleetco/shared/src/maintenance.ts for the documented
// reuse boundary, the per-dimension due-soon windows, and the UTC-calendar-day rule.
export {
  DEFAULT_SERVICE_DUE_SOON_WINDOWS,
  serviceScheduleState,
  nextDueForSchedule,
  worstServiceState,
} from "@fleetco/shared";
export type {
  ServiceIntervalType,
  ServiceScheduleState,
  ServiceDueSoonWindows,
  ServiceScheduleAnchor,
  VehicleMeterReading,
  ScheduleWithReading,
} from "@fleetco/shared";
