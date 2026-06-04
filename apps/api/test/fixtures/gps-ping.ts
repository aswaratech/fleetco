import { type GpsPing, type PrismaClient } from "@prisma/client";

// Test fixtures for the GPS-telematics slice (ADR-0029 T2). GpsPing's
// FKs are `vehicleId` (required), `tripId` (nullable), and `createdById`
// (required). The seedUser / seedVehicle / seedTrip helpers from
// trip.ts cover the parent rows; this file adds only the GpsPing-
// specific helper — the same convention every other slice's fixtures
// follow.
//
// IMPORTANT: the helper inserts ONLY the native Float latitude/longitude
// (plus the optional altitude/speed/heading and the timestamp). It does
// NOT supply `geometry` — that column is GENERATED ... STORED in the
// database (ADR-0029 commitment 8), so Prisma must never write it, and
// the Prisma client does not even expose it (it is declared
// Unsupported(...) in schema.prisma). The round-trip schema test asserts
// the database derived the geometry correctly from these floats.

export interface SeedGpsPingParams {
  vehicleId: string;
  createdById: string;
  tripId?: string | null;
  // Default fix is Kathmandu (lat 27.7172, lon 85.3240) — the same
  // coordinates the round-trip test pins, so a test asserting the
  // default row's derived geometry can rely on stable values across
  // reseeds. Override per-test when a specific position is needed.
  latitude?: number;
  longitude?: number;
  altitude?: number | null;
  speed?: number | null;
  heading?: number | null;
  timestamp?: Date;
}

export async function seedGpsPing(
  prisma: PrismaClient,
  params: SeedGpsPingParams,
): Promise<GpsPing> {
  return prisma.gpsPing.create({
    data: {
      vehicleId: params.vehicleId,
      createdById: params.createdById,
      tripId: params.tripId === undefined ? null : params.tripId,
      latitude: params.latitude ?? 27.7172,
      longitude: params.longitude ?? 85.324,
      altitude: params.altitude === undefined ? null : params.altitude,
      speed: params.speed === undefined ? null : params.speed,
      heading: params.heading === undefined ? null : params.heading,
      timestamp: params.timestamp ?? new Date("2026-02-15T08:00:00Z"),
    },
  });
}
