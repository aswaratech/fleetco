import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TrackerStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TrackersService } from "../src/modules/telematics/trackers.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { resetDb } from "./db";
import { randomImei, seedTrackerDevice } from "./fixtures/tracker-device";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Service-level tests for the TrackerDevice register (ADR-0042 M4), against
// the real database — the same boundary the geofences/drivers service tests
// pin. The load-bearing behaviors:
//
//   - the two P2002 → 409 translations name the collided field (imei vs the
//     one-tracker-per-vehicle slot);
//   - P2003 → 400 names the stale vehicle;
//   - the retirement invariant (RETIRED ⇒ unassigned) on the MERGED shape;
//   - the installedAt reset-on-reassignment rule;
//   - the vehicle-delete blocker now names a mounted tracker (the M3 schema
//     made the FK Restrict; before this slice the vehicles P2003 arm counted
//     only trips and would report "0 trips reference this vehicle").

describe("TrackersService (real database)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: TrackersService;
  let vehicles: VehiclesService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [TrackersService, VehiclesService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(TrackersService);
    vehicles = module.get(VehiclesService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
  });

  // ── create ──

  test("create registers a spare by default (status SPARE, no vehicle)", async () => {
    const created = await service.create({ imei: "350000000000001" }, adminId);
    expect(created.imei).toBe("350000000000001");
    expect(created.status).toBe(TrackerStatus.SPARE);
    expect(created.vehicleId).toBeNull();
    expect(created.vehicle).toBeNull();
    expect(created.createdById).toBe(adminId);
  });

  test("create with a vehicle assignment returns the vehicle's registration", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const created = await service.create(
      {
        imei: "350000000000002",
        vehicleId: vehicle.id,
        status: "ACTIVE",
        label: "FMC920 unit 1",
        installedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      adminId,
    );
    expect(created.status).toBe(TrackerStatus.ACTIVE);
    expect(created.vehicle?.id).toBe(vehicle.id);
    expect(created.vehicle?.registrationNumber).toBe(vehicle.registrationNumber);
  });

  test("duplicate IMEI → ConflictException (409) naming the IMEI", async () => {
    await seedTrackerDevice(prisma, { createdById: adminId, imei: "350000000000003" });
    try {
      await service.create({ imei: "350000000000003" }, adminId);
      throw new Error("expected ConflictException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain('IMEI "350000000000003"');
    }
  });

  test("second tracker on the same vehicle → ConflictException (409) naming the vehicle slot", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedTrackerDevice(prisma, { createdById: adminId, vehicleId: vehicle.id });
    try {
      await service.create({ imei: randomImei(), vehicleId: vehicle.id }, adminId);
      throw new Error("expected ConflictException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain("already has a tracker");
      expect((error as ConflictException).message).toContain(vehicle.id);
    }
  });

  test("stale-but-cuid-shaped vehicleId → BadRequestException (400) naming the vehicle", async () => {
    try {
      await service.create({ imei: randomImei(), vehicleId: "cnope0000000000000000000" }, adminId);
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain("does not exist");
    }
  });

  // ── list ──

  test("list filters by status and vehicleId; total reflects the filter", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedTrackerDevice(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      status: TrackerStatus.ACTIVE,
    });
    await seedTrackerDevice(prisma, { createdById: adminId, status: TrackerStatus.SPARE });
    await seedTrackerDevice(prisma, { createdById: adminId, status: TrackerStatus.RETIRED });

    const active = await service.list({ status: [TrackerStatus.ACTIVE] });
    expect(active.total).toBe(1);
    expect(active.items[0]?.vehicle?.registrationNumber).toBe(vehicle.registrationNumber);

    const byVehicle = await service.list({ vehicleId: vehicle.id });
    expect(byVehicle.total).toBe(1);

    const all = await service.list({});
    expect(all.total).toBe(3);
  });

  test("list sorts by imei ascending when asked", async () => {
    await seedTrackerDevice(prisma, { createdById: adminId, imei: "350000000000009" });
    await seedTrackerDevice(prisma, { createdById: adminId, imei: "350000000000001" });
    const { items } = await service.list({ sortBy: "imei", sortDir: "asc" });
    expect(items.map((t) => t.imei)).toEqual(["350000000000001", "350000000000009"]);
  });

  // ── getById ──

  test("getById throws NotFoundException with the id named", async () => {
    try {
      await service.getById("nonexistent-tracker-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-tracker-id");
    }
  });

  // ── update: assignment lifecycle ──

  test("update assigns a vehicle; explicit null unassigns and frees the slot", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, { createdById: adminId });

    const assigned = await service.update(tracker.id, {
      vehicleId: vehicle.id,
      status: "ACTIVE",
      installedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(assigned?.vehicleId).toBe(vehicle.id);
    expect(assigned?.status).toBe(TrackerStatus.ACTIVE);

    const unassigned = await service.update(tracker.id, { vehicleId: null, status: "SPARE" });
    expect(unassigned?.vehicleId).toBeNull();

    // The freed slot accepts a replacement unit.
    const replacement = await service.create(
      { imei: randomImei(), vehicleId: vehicle.id },
      adminId,
    );
    expect(replacement.vehicleId).toBe(vehicle.id);
  });

  test("update: changing vehicleId WITHOUT installedAt resets installedAt to null", async () => {
    const vehicleA = await seedVehicle(prisma, adminId);
    const vehicleB = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, {
      createdById: adminId,
      vehicleId: vehicleA.id,
      installedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    // Reassign A → B without a new install date: the stored date described
    // the mount on vehicle A and must not survive as a plausible lie.
    const reassigned = await service.update(tracker.id, { vehicleId: vehicleB.id });
    expect(reassigned?.vehicleId).toBe(vehicleB.id);
    expect(reassigned?.installedAt).toBeNull();
  });

  test("update: changing vehicleId WITH installedAt keeps the supplied date", async () => {
    const vehicleA = await seedVehicle(prisma, adminId);
    const vehicleB = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, {
      createdById: adminId,
      vehicleId: vehicleA.id,
      installedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const newDate = new Date("2026-07-02T00:00:00.000Z");
    const reassigned = await service.update(tracker.id, {
      vehicleId: vehicleB.id,
      installedAt: newDate,
    });
    expect(reassigned?.installedAt?.toISOString()).toBe(newDate.toISOString());
  });

  test("update: a label-only PATCH does not touch installedAt", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const installedAt = new Date("2026-06-01T00:00:00.000Z");
    const tracker = await seedTrackerDevice(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      installedAt,
    });
    const updated = await service.update(tracker.id, { label: "relabeled" });
    expect(updated?.label).toBe("relabeled");
    expect(updated?.installedAt?.toISOString()).toBe(installedAt.toISOString());
  });

  // ── update: the retirement invariant (merged shape) ──

  test("RETIRE while assigned → BadRequestException (unassign first)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      status: TrackerStatus.ACTIVE,
    });
    try {
      await service.update(tracker.id, { status: "RETIRED" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain("Unassign");
    }
  });

  test("RETIRE and unassign in ONE PATCH is allowed (the merged shape is clean)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      status: TrackerStatus.ACTIVE,
    });
    const retired = await service.update(tracker.id, { status: "RETIRED", vehicleId: null });
    expect(retired?.status).toBe(TrackerStatus.RETIRED);
    expect(retired?.vehicleId).toBeNull();
  });

  test("assigning a vehicle to a RETIRED tracker → BadRequestException (merged shape)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, {
      createdById: adminId,
      status: TrackerStatus.RETIRED,
    });
    try {
      await service.update(tracker.id, { vehicleId: vehicle.id });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
    }
  });

  test("update of an unknown id returns null (controller shapes the 404)", async () => {
    expect(await service.update("nonexistent-id", { label: "X" })).toBeNull();
  });

  test("update to a taken IMEI → ConflictException naming the IMEI", async () => {
    await seedTrackerDevice(prisma, { createdById: adminId, imei: "350000000000007" });
    const other = await seedTrackerDevice(prisma, { createdById: adminId });
    try {
      await service.update(other.id, { imei: "350000000000007" });
      throw new Error("expected ConflictException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toContain('IMEI "350000000000007"');
    }
  });

  // ── the vehicle-delete blocker (the M4 vehicles.service extension) ──

  test("deleting a vehicle with a mounted tracker → 409 naming the tracker, not '0 trips'", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedTrackerDevice(prisma, { createdById: adminId, vehicleId: vehicle.id });
    try {
      await vehicles.delete(vehicle.id);
      throw new Error("expected ConflictException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const message = (error as ConflictException).message;
      expect(message).toContain("mounted GPS tracker");
      expect(message).toContain("Unassign");
      expect(message).not.toContain("0 trips");
    }
  });

  test("deleting a vehicle after unassigning its tracker succeeds", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
    });
    await service.update(tracker.id, { vehicleId: null });
    expect(await vehicles.delete(vehicle.id)).toBe(true);
  });
});
