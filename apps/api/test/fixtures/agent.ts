import { randomUUID } from "node:crypto";

import {
  ServiceIntervalType,
  ServiceScheduleStatus,
  type Customer,
  type FuelLog,
  type Job,
  type PrismaClient,
  type ServiceSchedule,
} from "@prisma/client";

// Seed helpers for the AI agent tool-registry tests (ADR-0043 A4): the
// aggregates the existing fixture files do not cover (customers, jobs, fuel
// logs, service schedules). A NEW file rather than edits to the shared
// fixtures — the A4 branch stays file-disjoint from its siblings. Mirrors the
// fixtures/trip.ts style: unique-per-call uniques, sensible defaults,
// overrides for what a test pins.

export async function seedCustomer(
  prisma: PrismaClient,
  createdById: string,
  overrides: Partial<Omit<Customer, "id" | "createdAt" | "updatedAt" | "createdById">> = {},
): Promise<Customer> {
  return prisma.customer.create({
    data: {
      name: overrides.name ?? `Himalaya Constructions ${randomUUID().slice(0, 6)}`,
      contactPerson: "contactPerson" in overrides ? overrides.contactPerson : "Sita Devi",
      phone: overrides.phone ?? "+977-9811111111",
      email: "email" in overrides ? overrides.email : null,
      panNumber: "panNumber" in overrides ? overrides.panNumber : null,
      address: "address" in overrides ? overrides.address : null,
      ...(overrides.status ? { status: overrides.status } : {}),
      createdById,
    },
  });
}

export async function seedJob(
  prisma: PrismaClient,
  params: {
    customerId: string;
    createdById: string;
  } & Partial<Omit<Job, "id" | "createdAt" | "updatedAt" | "customerId" | "createdById">>,
): Promise<Job> {
  return prisma.job.create({
    data: {
      jobNumber: params.jobNumber ?? `JOB-2026-${randomUUID().slice(0, 5)}`,
      customerId: params.customerId,
      description: params.description ?? "Haul aggregate Kalimati -> site",
      ...(params.status ? { status: params.status } : {}),
      scheduledStartDate: params.scheduledStartDate ?? null,
      scheduledEndDate: params.scheduledEndDate ?? null,
      actualStartDate: params.actualStartDate ?? null,
      actualEndDate: params.actualEndDate ?? null,
      notes: params.notes ?? null,
      createdById: params.createdById,
    },
  });
}

export async function seedFuelLog(
  prisma: PrismaClient,
  params: {
    vehicleId: string;
    createdById: string;
  } & Partial<Omit<FuelLog, "id" | "createdAt" | "updatedAt" | "vehicleId" | "createdById">>,
): Promise<FuelLog> {
  return prisma.fuelLog.create({
    data: {
      vehicleId: params.vehicleId,
      tripId: params.tripId ?? null,
      date: params.date ?? new Date("2026-06-15T08:00:00Z"),
      litersMl: params.litersMl ?? 45_000,
      pricePerLiterPaisa: params.pricePerLiterPaisa ?? 16_500,
      totalCostPaisa: params.totalCostPaisa ?? 742_500,
      odometerReadingKm: params.odometerReadingKm ?? null,
      station: params.station ?? null,
      receiptNumber: params.receiptNumber ?? null,
      notes: params.notes ?? null,
      createdById: params.createdById,
    },
  });
}

export async function seedServiceSchedule(
  prisma: PrismaClient,
  params: {
    vehicleId: string;
    createdById: string;
  } & Partial<
    Omit<ServiceSchedule, "id" | "createdAt" | "updatedAt" | "vehicleId" | "createdById">
  >,
): Promise<ServiceSchedule> {
  return prisma.serviceSchedule.create({
    data: {
      vehicleId: params.vehicleId,
      name: params.name ?? `Engine oil change ${randomUUID().slice(0, 6)}`,
      description: params.description ?? null,
      intervalType: params.intervalType ?? ServiceIntervalType.DISTANCE_KM,
      intervalValue: params.intervalValue ?? 5_000,
      status: params.status ?? ServiceScheduleStatus.ACTIVE,
      lastServiceAt: params.lastServiceAt ?? new Date("2026-05-01T00:00:00Z"),
      lastServiceOdometerKm: params.lastServiceOdometerKm ?? 75_000,
      lastServiceEngineHours: params.lastServiceEngineHours ?? null,
      createdById: params.createdById,
    },
  });
}
