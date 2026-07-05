// Web-side view of the API's Driver row. Mirrors the Prisma model in
// apps/api/prisma/schema.prisma (model Driver) at the field level; dates
// arrive as ISO strings over the JSON wire, so they are typed as `string`
// here rather than `Date` to avoid a hidden coercion surface. The list
// endpoint and the detail endpoint return this shape; promoting to a
// shared @fleetco/shared package is deferred until a second app (driver
// app, Phase 2) needs the type.
//
// The iter-6 read path does not surface a write form; the iter-7
// kickoff adds CreateDriverFormSchema / UpdateDriverFormSchema in
// apps/web/src/lib/drivers-schema.ts the same way Vehicles did between
// iters 1 and 2.
export interface Driver {
  id: string;
  fullName: string;
  licenseNumber: string;
  licenseClass: "LMV" | "HMV" | "HTV" | "HPMV";
  phone: string;
  dateOfBirth: string | null;
  hiredAt: string;
  licenseExpiresAt: string;
  status: "ACTIVE" | "ON_LEAVE" | "SUSPENDED" | "TERMINATED";
  terminatedAt: string | null;
  // The mobile driver-app login this Driver is linked to, if any (nullable
  // unique FK; ADR-0034 c8's linking write path — POST/DELETE
  // /api/v1/drivers/:id/login-link). Always present on the wire (a plain
  // scalar column); `loginEmail` (the resolved email) is a detail-page-only
  // enrichment, not part of this shared type — see the driver detail page.
  userId: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
