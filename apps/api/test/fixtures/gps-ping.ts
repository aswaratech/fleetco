import { type GpsPing, type PrismaClient } from "@prisma/client";

import { type GpsPingInput } from "../../src/modules/telematics/telematics.schemas";

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

// Build a synthetic GPS-ping INPUT object — the WIRE shape the T3 ingestion
// endpoint and `gps-ingest` worker consume, NOT a database row. The producer
// (the React Native driver app) does not exist yet, so the endpoint and worker
// are exercised with these synthetic batches posted as an authenticated
// principal — exactly as auth and RBAC were tested before any office-staff
// account existed (ADR-0029 commitment 10).
//
// IMPORTANT: `timestamp` is an ISO STRING, not a Date — the wire/job payload
// carries it as a string (it survives BullMQ's JSON serialization unchanged),
// and the worker maps it to `new Date(...)` at insert. The default fix is the
// same Kathmandu coordinate the schema round-trip test pins, so a worker test
// can assert the derived geometry against stable values. `createdById` is NOT
// part of the input — the endpoint fills it from the session (ADR-0021), so it
// travels in the job payload, not each ping.
export function makeGpsPingInput(params: {
  vehicleId: string;
  tripId?: string | null;
  latitude?: number;
  longitude?: number;
  altitude?: number | null;
  speed?: number | null;
  heading?: number | null;
  timestamp?: string;
}): GpsPingInput {
  return {
    vehicleId: params.vehicleId,
    ...(params.tripId !== undefined ? { tripId: params.tripId } : {}),
    latitude: params.latitude ?? 27.7172,
    longitude: params.longitude ?? 85.324,
    ...(params.altitude !== undefined ? { altitude: params.altitude } : {}),
    ...(params.speed !== undefined ? { speed: params.speed } : {}),
    ...(params.heading !== undefined ? { heading: params.heading } : {}),
    timestamp: params.timestamp ?? "2026-02-15T08:00:00Z",
  };
}
