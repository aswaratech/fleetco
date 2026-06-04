import type { GeofenceTypeName } from "@/lib/geofences-schema";

// Web-side view of the API's Geofence row (ADR-0030 G3). Mirrors the
// Prisma model (apps/api/prisma/schema.prisma, model Geofence) at the
// field level. Dates arrive as ISO strings over the JSON wire, so they are
// typed as `string` here, not `Date`.
//
// Both the list and detail endpoints return this exact shape. The response
// carries `boundaryWkt` (the stored `POLYGON((…))` WKT) and a nullable
// `customerId`, but it does NOT nest the owning Customer, nor expose the
// generated `geometry(Polygon,4326)` column (Prisma never selects the
// Unsupported geometry). To render a customer NAME, the list/detail pages
// resolve it with a separate fetch against the customers API and map by id
// — see page.tsx. Promoting to a shared @fleetco/shared package is
// deferred until a second app (driver app, Phase 2) needs the type, the
// same calculus as the other web `types.ts` modules.
//
// `GeofenceTypeName` is re-exported from lib/geofences-schema (the single
// source of truth for the type union + the option/label maps) so a page
// can import the row type and the type union from one module.
export type { GeofenceTypeName };

export interface Geofence {
  id: string;
  name: string;
  type: GeofenceTypeName;
  boundaryWkt: string;
  customerId: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
