// Web-side view of the API's Vehicle row. Mirrors the Prisma model in
// apps/api/prisma/schema.prisma (model Vehicle) at the field level; dates
// arrive as ISO strings over the JSON wire, so they are typed as `string`
// here rather than `Date` to avoid a hidden coercion surface. The list
// endpoint, the detail endpoint, and the edit form's fetch all return
// this shape; promoting to a shared @fleetco/shared package is deferred
// until a second app (driver app, Phase 2) needs the type.
export interface Vehicle {
  id: string;
  registrationNumber: string;
  kind: "TRUCK" | "TIPPER" | "EXCAVATOR" | "LOADER" | "GRADER" | "OTHER";
  make: string;
  model: string;
  year: number;
  status: "ACTIVE" | "IN_MAINTENANCE" | "RETIRED" | "SOLD";
  odometerStartKm: number;
  odometerCurrentKm: number;
  acquiredAt: string;
  retiredAt: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
