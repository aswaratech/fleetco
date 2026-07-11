import { type PrismaClient, type Site, SiteKind } from "@prisma/client";

// Test fixtures for the Sites slice (ADR-0047 W2). Site's only FK is
// `createdById` (required); the seedUser helper from trip.ts covers that
// parent row. This file adds only the Site-specific helper — the same
// convention every other slice's fixtures follow (gps-ping.ts, geofence.ts).
//
// IMPORTANT: the helper inserts ONLY the native Float latitude/longitude
// (plus name/kind/optional address+contact). It does NOT supply `geometry`
// — that column is GENERATED ... STORED in the database (ADR-0047 c4, the
// GpsPing Point hybrid reused), so Prisma must never write it, and the
// Prisma client does not even expose it (it is declared Unsupported(...) in
// schema.prisma). The round-trip schema test asserts the database derived
// the geometry correctly from these floats (ST_X = lon, ST_Y = lat).

export interface SeedSiteParams {
  createdById: string;
  name?: string;
  kind?: SiteKind;
  // Default pin is Kathmandu (lat 27.7172, lon 85.3240) — the same
  // coordinates the round-trip test pins, so a test asserting the default
  // site's derived geometry can rely on stable values across reseeds.
  // Override per-test when a specific position is needed.
  latitude?: number;
  longitude?: number;
  // Optional fields — undefined means "leave null" (the honest pre-fill
  // absence), matching the gps-ping/geofence fixture convention.
  address?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}

export async function seedSite(prisma: PrismaClient, params: SeedSiteParams): Promise<Site> {
  return prisma.site.create({
    data: {
      name: params.name ?? "Kalimati Crusher",
      kind: params.kind ?? SiteKind.CRUSHER,
      latitude: params.latitude ?? 27.7172,
      longitude: params.longitude ?? 85.324,
      address: params.address === undefined ? null : params.address,
      contactName: params.contactName === undefined ? null : params.contactName,
      contactPhone: params.contactPhone === undefined ? null : params.contactPhone,
      createdById: params.createdById,
    },
  });
}
