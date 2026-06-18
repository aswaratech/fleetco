// Vehicle-compliance expiry classification for the web. The implementation now
// lives in @fleetco/shared (ADR-0038 commitment 6 — the load-bearing drift
// guard) so the web BADGE and the apps/api reminder DIGEST classify an item
// from ONE copy that cannot drift. This module re-exports the shared symbols
// under the SAME `@/lib/compliance` path the web has always used, so every
// existing importer (vehicles/page.tsx, vehicles/[id]/page.tsx, lib/dashboard.ts,
// lib/maintenance.ts, and the compliance.test.ts suite) is unchanged. See
// @fleetco/shared/src/compliance.ts for the documented UTC-calendar-day rule.
export {
  complianceBadgeState,
  worstComplianceState,
  thresholdState,
  utcStartOfDayMs,
  MS_PER_DAY,
} from "@fleetco/shared";
export type { ComplianceBadgeState, ThresholdState } from "@fleetco/shared";
