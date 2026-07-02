import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma, TrackerStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { IngestBatchSchema } from "../src/modules/telematics/telematics.schemas";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Schema-level integration tests for the TrackerDevice aggregate and the
// gps_ping hardware riders (ADR-0042 c6/c7, ticket M3) against real Postgres.
// The M3 slice is schema-only (the G1 pattern): model + hand-authored
// migration + truncate entry + these tests; the CRUD API is M4 and the ingest
// adapter is M5. What this file pins:
//   1. TrackerDevice round-trip + the two uniqueness rails (one row per IMEI,
//      at most one mounted tracker per vehicle) + the vehicle delete-blocker.
//   2. gps_ping.ignition round-trips through createMany (the insertBatch
//      write shape) and defaults NULL for producers that omit it.
//   3. The migration's index swap actually happened: the composite
//      (vehicleId, timestamp DESC) exists and the superseded single-column
//      index is gone — a hand-authored migration can silently diverge from
//      schema.prisma in exactly this way, so the database is asserted
//      directly via pg_indexes.
//   4. The ingest boundary accepts the new optional `ignition` and rejects a
//      non-boolean (the pipe-layer contract the M5 adapter re-validates
//      against).

describe("TrackerDevice schema (ADR-0042 M3)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    vehicleId = (await seedVehicle(prisma, adminId)).id;
  });

  test("create round-trips; status defaults to SPARE for an uninstalled unit", async () => {
    const created = await prisma.trackerDevice.create({
      data: {
        imei: "356938035643809",
        label: "FMC920 unit 1",
        simMsisdn: "+9779800000001",
        createdById: adminId,
      },
    });
    expect(created.status).toBe(TrackerStatus.SPARE);
    expect(created.vehicleId).toBeNull();
    expect(created.installedAt).toBeNull();

    const mounted = await prisma.trackerDevice.update({
      where: { id: created.id },
      data: {
        vehicleId,
        status: TrackerStatus.ACTIVE,
        installedAt: new Date("2026-07-02T06:00:00Z"),
      },
      include: { vehicle: true },
    });
    expect(mounted.vehicle?.id).toBe(vehicleId);
    expect(mounted.status).toBe(TrackerStatus.ACTIVE);
  });

  test("imei is unique — a second row for the same physical device is P2002", async () => {
    await prisma.trackerDevice.create({
      data: { imei: "356938035643809", createdById: adminId },
    });
    await expect(
      prisma.trackerDevice.create({
        data: { imei: "356938035643809", createdById: adminId },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("at most one mounted tracker per vehicle — a second assignment is P2002", async () => {
    await prisma.trackerDevice.create({
      data: { imei: "356938035643809", vehicleId, createdById: adminId },
    });
    await expect(
      prisma.trackerDevice.create({
        data: { imei: "356938035643810", vehicleId, createdById: adminId },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("deleting a vehicle with a mounted tracker is blocked (P2003, onDelete: Restrict)", async () => {
    await prisma.trackerDevice.create({
      data: { imei: "356938035643809", vehicleId, createdById: adminId },
    });
    await expect(prisma.vehicle.delete({ where: { id: vehicleId } })).rejects.toMatchObject({
      code: "P2003",
    });
    // The blocker protected both rows.
    expect(await prisma.vehicle.count({ where: { id: vehicleId } })).toBe(1);
    expect(await prisma.trackerDevice.count()).toBe(1);
  });

  test("gps_ping.ignition round-trips through createMany and defaults NULL when omitted", async () => {
    // The exact write shape insertBatch uses (a bulk createMany of native
    // columns): one hardware ping carrying ignition, one legacy-shaped ping
    // omitting it.
    await prisma.gpsPing.createMany({
      data: [
        {
          vehicleId,
          latitude: 27.7172,
          longitude: 85.324,
          ignition: true,
          timestamp: new Date("2026-07-02T06:00:00Z"),
          createdById: adminId,
        },
        {
          vehicleId,
          latitude: 27.7173,
          longitude: 85.3241,
          timestamp: new Date("2026-07-02T06:00:20Z"),
          createdById: adminId,
        },
      ],
    });
    const rows = await prisma.gpsPing.findMany({ orderBy: { timestamp: "asc" } });
    expect(rows.map((r) => r.ignition)).toEqual([true, null]);
  });

  test("the migration swapped the gps_ping index: composite present, single-column gone", async () => {
    const indexes = await prisma.$queryRaw<{ indexname: string }[]>(
      Prisma.sql`SELECT indexname FROM pg_indexes WHERE tablename = 'gps_ping'`,
    );
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain("gps_ping_vehicleId_timestamp_idx");
    expect(names).not.toContain("gps_ping_vehicleId_idx");
  });
});

describe("ingest boundary accepts the ignition rider (ADR-0042 M3)", () => {
  const basePing = {
    vehicleId: "cm0000000000000000000001",
    latitude: 27.7172,
    longitude: 85.324,
    timestamp: "2026-07-02T06:00:00Z",
  };

  test("ignition true / false / null / omitted all parse", () => {
    for (const ignition of [true, false, null, undefined]) {
      const ping = ignition === undefined ? basePing : { ...basePing, ignition };
      const result = IngestBatchSchema.safeParse({ pings: [ping] });
      expect(result.success).toBe(true);
    }
  });

  test("a non-boolean ignition is corruption → rejected", () => {
    const result = IngestBatchSchema.safeParse({
      pings: [{ ...basePing, ignition: "on" }],
    });
    expect(result.success).toBe(false);
  });
});
