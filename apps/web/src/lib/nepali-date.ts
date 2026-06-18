// Bikram Sambat (BS) date formatting for the web. The implementation now lives
// in @fleetco/shared (ADR-0038 commitment 6) so the web's date display and the
// apps/api reminder DIGEST render dates from ONE copy that cannot drift. This
// module re-exports the shared symbols under the SAME `@/lib/nepali-date` path
// the web has always used, so every existing importer (the ~10 list/detail
// pages, components/nepali-date.tsx, lib/nepali-date-picker.ts, and the
// nepali-date.test.ts suite) is unchanged. See @fleetco/shared/src/nepali-date.ts
// for the documented UTC-calendar-day rule and the BS_MONTHS anti-drift array.
export { formatNepaliDate, BS_MONTHS } from "@fleetco/shared";
export type { NepaliDateFormat } from "@fleetco/shared";
