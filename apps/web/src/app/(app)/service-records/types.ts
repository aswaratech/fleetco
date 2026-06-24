// Web-side view of the API's ServiceRecord row (ADR-0037 B3 / B5). Mirrors the
// Prisma model (apps/api/prisma/schema.prisma, model ServiceRecord) at the field
// level. Dates arrive as ISO strings over the JSON wire, so they are typed as
// `string` here, not `Date`; meter readings are integers in their minor units
// (km / tenths-of-an-hour) or null.
//
// Both the list and detail endpoints return this exact bare shape — the API does
// NOT nest the Vehicle, the ServiceSchedule, or the ExpenseLog (the controller's
// return type is the bare `ServiceRecord`). To render the vehicle registration,
// the schedule name, and the linked expense's amount, the pages resolve each
// with a separate fetch and map by id (the Geofences enrichment pattern). The
// cost is ALWAYS read THROUGH the linked ExpenseLog's amountPaisa — there is no
// money column on a ServiceRecord (ADR-0037 c6).
//
// Promoting to a shared @fleetco/shared package is deferred until a second app
// needs the type, the same calculus as the other web `types.ts` modules.

export interface ServiceRecord {
  id: string;
  vehicleId: string;
  serviceScheduleId: string | null;
  expenseLogId: string | null;
  performedAt: string;
  odometerKm: number | null;
  engineHours: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  createdById: string;
}

// The shared `{ items, total, skip, take, sortBy, sortDir }` list envelope the
// API echoes back (apps/api ServiceRecordsListResponse).
export interface ServiceRecordsListResponse {
  items: ServiceRecord[];
  total: number;
  skip: number;
  take: number;
  sortBy: "performedAt" | "createdAt";
  sortDir: "asc" | "desc";
}
