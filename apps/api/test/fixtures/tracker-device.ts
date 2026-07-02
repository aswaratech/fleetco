import { randomUUID } from "node:crypto";
import { type PrismaClient, type TrackerDevice, TrackerStatus } from "@prisma/client";

// Test fixtures for the TrackerDevice register (ADR-0042 M3/M4).
// TrackerDevice's FKs are `vehicleId` (nullable @unique — null = spare, set =
// the one mounted tracker on that vehicle) and `createdById` (required). The
// seedUser / seedVehicle helpers from trip.ts cover the parent rows; this
// file adds only the tracker-specific helper — the same convention every
// other slice's fixtures follow.

// Generate a unique, valid 15-digit IMEI per call so the `imei @unique`
// constraint never collides between tests. "35" prefix looks like a real
// TAC without claiming to be one.
export function randomImei(): string {
  return `35${randomUUID().replace(/\D/g, "").padEnd(13, "0").slice(0, 13)}`;
}

export interface SeedTrackerDeviceParams {
  createdById: string;
  imei?: string;
  // null (or omitted) = spare; a Vehicle id mounts the tracker on it.
  vehicleId?: string | null;
  label?: string | null;
  simMsisdn?: string | null;
  status?: TrackerStatus;
  installedAt?: Date | null;
}

export async function seedTrackerDevice(
  prisma: PrismaClient,
  params: SeedTrackerDeviceParams,
): Promise<TrackerDevice> {
  return prisma.trackerDevice.create({
    data: {
      imei: params.imei ?? randomImei(),
      vehicleId: params.vehicleId === undefined ? null : params.vehicleId,
      label: params.label ?? null,
      simMsisdn: params.simMsisdn ?? null,
      status: params.status ?? TrackerStatus.SPARE,
      installedAt: params.installedAt ?? null,
      createdById: params.createdById,
    },
  });
}
