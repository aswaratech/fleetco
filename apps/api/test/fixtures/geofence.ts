import { type Geofence, GeofenceType, type PrismaClient } from "@prisma/client";

// Test fixtures for the Geofence slice (ADR-0030 G1). Geofence's FKs are
// `customerId` (nullable — set only for CUSTOMER_SITE fences) and
// `createdById` (required). The seedUser / seedCustomer helpers from
// trip.ts / customer.ts cover the parent rows; this file adds only the
// Geofence-specific helper — the same convention every other slice's
// fixtures follow.
//
// IMPORTANT: the helper inserts ONLY the canonical `boundaryWkt` text (plus
// name / type / FKs). It does NOT supply `geometry` — that column is
// GENERATED ... STORED in the database (ADR-0030 commitment 1), so Prisma
// must never write it, and the Prisma client does not even expose it (it is
// declared Unsupported(...) in schema.prisma). The round-trip schema test
// asserts the database derived the geometry correctly from boundaryWkt.

// A small valid Kathmandu-area square ring, WKT lon-lat (X Y) order, closed
// (first vertex repeated last). Used as the default fence and pinned by the
// round-trip test, so a test asserting the derived geometry can rely on
// stable values. The square spans lon 85.30–85.35, lat 27.70–27.75 — well
// clear of the equator/prime-meridian, so a lon/lat swap (27.x where 85.x
// belongs) would be unmissable.
export const KATHMANDU_SQUARE_WKT =
  "POLYGON((85.30 27.70, 85.35 27.70, 85.35 27.75, 85.30 27.75, 85.30 27.70))";

// A self-intersecting "bowtie" ring over the same corner coordinates: the
// 2nd and 3rd vertices are swapped so two edges cross. It is SYNTACTICALLY a
// valid POLYGON (ST_GeomFromText parses it; the geometry(Polygon,4326) typmod
// accepts it), so it stores — but it is geometrically INVALID (ST_IsValid =
// false). The G2 create/update service gates on ST_IsValid and rejects this
// as 400; the schema test pins the hazard that gate exists to prevent.
export const BOWTIE_WKT =
  "POLYGON((85.30 27.70, 85.35 27.75, 85.35 27.70, 85.30 27.75, 85.30 27.70))";

export interface SeedGeofenceParams {
  createdById: string;
  name?: string;
  type?: GeofenceType;
  // null (or omitted) for DEPOT / ROUTE_CORRIDOR; a Customer id for
  // CUSTOMER_SITE. The type/ownership invariant is a G2 service/Zod concern,
  // NOT a DB constraint, so this fixture does not enforce it — a test that
  // needs an owned fence passes both `type: CUSTOMER_SITE` and a customerId.
  customerId?: string | null;
  // A closed WGS84 polygon ring as WKT (lon-lat order). Defaults to the
  // Kathmandu square above.
  boundaryWkt?: string;
}

export async function seedGeofence(
  prisma: PrismaClient,
  params: SeedGeofenceParams,
): Promise<Geofence> {
  return prisma.geofence.create({
    data: {
      name: params.name ?? "Kathmandu Depot",
      type: params.type ?? GeofenceType.DEPOT,
      boundaryWkt: params.boundaryWkt ?? KATHMANDU_SQUARE_WKT,
      customerId: params.customerId === undefined ? null : params.customerId,
      createdById: params.createdById,
    },
  });
}
