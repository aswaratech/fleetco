import type { SiteKindName } from "@/lib/sites-schema";

// Web-side view of the API's Site row (ADR-0047 W5). Mirrors the Prisma model
// (apps/api/prisma/schema.prisma, model Site) at the field level. Dates arrive
// as ISO strings over the JSON wire, so they are typed `string`, not `Date`.
//
// `latitude` / `longitude` arrive as JSON numbers (Prisma Float). The generated
// `geometry(Point, 4326)` column is NEVER selected by Prisma (declared
// Unsupported in schema.prisma), so it is absent from this shape — the map
// surface reads the two floats, not the WKB blob. `contactName` / `contactPhone`
// are Tier-2 PII (ADR-0047 c6). Both the list and detail endpoints return this
// exact shape.
//
// `SiteKindName` is re-exported from lib/sites-schema (the single source of
// truth for the kind union + the option/label maps) so a page can import the
// row type and the kind union from one module. Promoting to a shared package is
// deferred, the same calculus as the other web `types.ts` modules.
export type { SiteKindName };

export interface Site {
  id: string;
  name: string;
  kind: SiteKindName;
  latitude: number;
  longitude: number;
  address: string | null;
  contactName: string | null;
  contactPhone: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}
