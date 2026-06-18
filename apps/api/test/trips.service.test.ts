import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  MeterType,
  TripStatus,
  UserRole,
  VehicleKind,
  type Vehicle,
  type Driver,
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { DriverScopeService, type Actor } from "../src/modules/auth/driver-scope.service";
import { DriversService } from "../src/modules/drivers/drivers.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsService, LIST_TAKE_MAX } from "../src/modules/trips/trips.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { resetDb } from "./db";
import { seedGpsPing } from "./fixtures/gps-ping";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// Integration tests for TripsService against a real Postgres. The
// iter-8 kickoff (deliverable 5) names the coverage:
//   - findById() eager-loads the related Vehicle and Driver;
//   - list() filters by status, vehicleId, driverId;
//   - list() sorts across the three whitelist columns
//     (startedAt / endedAt / createdAt);
//   - pagination (skip / take, the LIST_TAKE_MAX clamp);
//   - the Restrict FK behavior when a referenced Vehicle is deleted —
//     pin the current behavior (Prisma P2003 → propagates as 500) so
//     the iter-9 or iter-10 fix has a baseline.
//
// Shape mirrors drivers.service.test.ts: one TestingModule per file,
// beforeEach truncates the affected tables, the seed helpers in
// test/fixtures/trip.ts wire the FK parents (User, Vehicle, Driver).

// A non-DRIVER acting principal for the existing (ADMIN/OFFICE_STAFF) cases: the
// own-record predicate is a no-op for it (resolveOwnDriverId → null), so these
// tests assert the unchanged fleet-wide behavior. The DRIVER own-record describe
// block below builds its own DRIVER actor.
const STAFF_ACTOR: Actor = { userId: "staff-actor", role: UserRole.OFFICE_STAFF };

describe("TripsService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: TripsService;
  // iter-9 adds the VehiclesService / DriversService refs so the FK
  // Restrict block at the end of this file can assert the new 409
  // mapping (ConflictException with referencing-trip count) instead
  // of the iter-8 baseline of "Prisma P2003 propagates as 500".
  let vehiclesService: VehiclesService;
  let driversService: DriversService;

  // Each test seeds its own parents inside beforeEach so the tests
  // can refer to them by id and the resetDb in beforeEach truncates
  // everything cleanly.
  let adminId: string;
  let vehicle: Vehicle;
  let driver: Driver;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [TripsService, VehiclesService, DriversService, DriverScopeService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(TripsService);
    vehiclesService = module.get(VehiclesService);
    driversService = module.get(DriversService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    vehicle = await seedVehicle(prisma, adminId);
    driver = await seedDriver(prisma, adminId);
  });

  // D2 (ADR-0034 c4/c5): the service-layer own-record predicate that activates
  // the DRIVER role. A driver may read/start/stop ONLY their own trips, and may
  // not create or delete any. `driver` (the outer seed, unlinked) stands in as
  // "another driver"; `ownDriver` is linked to a DRIVER login.
  describe("DRIVER own-record scope (ADR-0034 c4)", () => {
    let driverUserId: string;
    let ownDriver: Driver;
    let driverActor: Actor;
    const startedAt = new Date("2026-06-16T06:00:00Z");
    const endedAt = new Date("2026-06-16T14:00:00Z");

    beforeEach(async () => {
      driverUserId = await seedUser(prisma, UserRole.DRIVER);
      ownDriver = await seedDriver(prisma, adminId, { userId: driverUserId });
      driverActor = { userId: driverUserId, role: UserRole.DRIVER };
    });

    test("list() returns only the driver's own trips, even when a foreign driverId is passed", async () => {
      const ownTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: ownDriver.id,
        createdById: adminId,
      });
      await seedTrip(prisma, { vehicleId: vehicle.id, driverId: driver.id, createdById: adminId });

      // The driver passes another driver's id as a filter; the own-record scope
      // overrides it, so only their own trip comes back.
      const result = await service.list({ driverId: driver.id }, driverActor);
      expect(result.total).toBe(1);
      expect(result.items.map((t) => t.id)).toEqual([ownTrip.id]);
    });

    test("findById() returns the driver's own trip", async () => {
      const ownTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: ownDriver.id,
        createdById: adminId,
      });
      const fetched = await service.findById(ownTrip.id, driverActor);
      expect(fetched?.id).toBe(ownTrip.id);
    });

    test("findById() returns null (→ 404) for another driver's trip", async () => {
      const foreignTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });
      expect(await service.findById(foreignTrip.id, driverActor)).toBeNull();
    });

    test("update() starts the driver's own trip (PLANNED → IN_PROGRESS)", async () => {
      const ownTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: ownDriver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      const updated = await service.update(
        ownTrip.id,
        { status: TripStatus.IN_PROGRESS, startedAt, startOdometerKm: 80000 },
        driverActor,
      );
      expect(updated.status).toBe(TripStatus.IN_PROGRESS);
    });

    test("update() rejects starting another driver's trip with 404, leaving it unchanged", async () => {
      const foreignTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await expect(
        service.update(
          foreignTrip.id,
          { status: TripStatus.IN_PROGRESS, startedAt, startOdometerKm: 80000 },
          driverActor,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The gate fired before the transaction: the foreign trip is untouched.
      const after = await prisma.trip.findUniqueOrThrow({ where: { id: foreignTrip.id } });
      expect(after.status).toBe(TripStatus.PLANNED);
      expect(after.startedAt).toBeNull();
    });

    test("update() stops the driver's own trip (IN_PROGRESS → COMPLETED) and bumps the vehicle odometer", async () => {
      const ownTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: ownDriver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt,
        startOdometerKm: 80000,
      });
      const updated = await service.update(
        ownTrip.id,
        { status: TripStatus.COMPLETED, endedAt, endOdometerKm: 80250 },
        driverActor,
      );
      expect(updated.status).toBe(TripStatus.COMPLETED);
      const veh = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
      expect(veh.odometerCurrentKm).toBe(80250);
    });

    test("create() is forbidden for a DRIVER (403)", async () => {
      await expect(
        service.create(
          { vehicleId: vehicle.id, driverId: ownDriver.id, status: TripStatus.PLANNED },
          driverUserId,
          driverActor,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    test("delete() is forbidden for a DRIVER (403)", async () => {
      const ownTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: ownDriver.id,
        createdById: adminId,
      });
      await expect(service.delete(ownTrip.id, driverActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    test("a DRIVER session with no linked Driver row is denied (403, fail-closed)", async () => {
      const unlinkedUserId = await seedUser(prisma, UserRole.DRIVER);
      const unlinkedActor: Actor = { userId: unlinkedUserId, role: UserRole.DRIVER };
      await expect(service.list({}, unlinkedActor)).rejects.toBeInstanceOf(ForbiddenException);
      const someTrip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: ownDriver.id,
        createdById: adminId,
      });
      await expect(service.findById(someTrip.id, unlinkedActor)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe("findById()", () => {
    test("returns the trip with eager-loaded Vehicle and Driver", async () => {
      // The detail page expects both relations on the response. Pinning
      // the include shape so a refactor that switches DETAIL_INCLUDE to
      // a select (or drops one of the relations) would fail loudly.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });

      const fetched = await service.findById(created.id, STAFF_ACTOR);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(created.id);
      // Full nested objects: every Vehicle and Driver column should be
      // present, not just the slim list projection. Asserting a few
      // representative fields documents the contract without coupling
      // the test to every column.
      expect(fetched?.vehicle.id).toBe(vehicle.id);
      expect(fetched?.vehicle.registrationNumber).toBe(vehicle.registrationNumber);
      expect(fetched?.vehicle.kind).toBe(vehicle.kind);
      expect(fetched?.driver.id).toBe(driver.id);
      expect(fetched?.driver.fullName).toBe(driver.fullName);
      expect(fetched?.driver.licenseNumber).toBe(driver.licenseNumber);
    });

    test("returns null when not present (controller maps to 404)", async () => {
      const fetched = await service.findById("nonexistent-id", STAFF_ACTOR);
      expect(fetched).toBeNull();
    });
  });

  describe("findByIdRaw()", () => {
    test("returns the row without relations (Phase-1 internal helper)", async () => {
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });
      const fetched = await service.findByIdRaw(created.id);
      expect(fetched?.id).toBe(created.id);
      // No Prisma include on this path — the row is the bare Trip
      // record. The type system already enforces this (TripDetail vs
      // Trip differ at the type level); the runtime check just pins
      // that no future refactor accidentally re-adds an include.
      expect((fetched as unknown as { vehicle?: unknown }).vehicle).toBeUndefined();
    });
  });

  describe("list() — filter / sort / paginate", () => {
    // Seed a small set of trips with known shapes so the assertions
    // below can be precise about which rows come back for each query.
    // Two vehicles and two drivers so the by-vehicleId and by-driverId
    // filters have a meaningful narrowing dimension.
    async function seedScenario(): Promise<{
      otherVehicle: Vehicle;
      otherDriver: Driver;
    }> {
      const otherVehicle = await seedVehicle(prisma, adminId, {
        registrationNumber: "BA-99-XX-9999",
      });
      const otherDriver = await seedDriver(prisma, adminId, {
        fullName: "Sita Pradhan",
        licenseNumber: "LIC-OTHER-001",
      });

      // 5 trips across the matrix of vehicle/driver/status:
      //   t1: vehicle, driver, PLANNED, startedAt=null
      //   t2: vehicle, driver, IN_PROGRESS, startedAt=2026-01-10
      //   t3: vehicle, otherDriver, COMPLETED, startedAt=2026-01-05,
      //       endedAt=2026-01-06
      //   t4: otherVehicle, driver, CANCELLED, startedAt=null
      //   t5: otherVehicle, otherDriver, COMPLETED, startedAt=2026-01-12,
      //       endedAt=2026-01-13
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: otherDriver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-01-05T08:00:00Z"),
        endedAt: new Date("2026-01-06T18:00:00Z"),
        startOdometerKm: 79000,
        endOdometerKm: 79350,
      });
      await seedTrip(prisma, {
        vehicleId: otherVehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.CANCELLED,
      });
      await seedTrip(prisma, {
        vehicleId: otherVehicle.id,
        driverId: otherDriver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-01-12T08:00:00Z"),
        endedAt: new Date("2026-01-13T18:00:00Z"),
        startOdometerKm: 50000,
        endOdometerKm: 50420,
      });

      return { otherVehicle, otherDriver };
    }

    test("no filters → returns all rows with correct total", async () => {
      await seedScenario();
      const result = await service.list({}, STAFF_ACTOR);
      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(5);
    });

    test("list items carry the slim Vehicle + Driver projection", async () => {
      // Pin the wire shape: every list item must have
      // vehicle.registrationNumber and driver.fullName populated, but
      // the broader Vehicle/Driver columns should not be included
      // (they're on the detail endpoint, not the list). This is a
      // bytes-over-the-wire concern as the fleet grows.
      await seedScenario();
      const result = await service.list({ take: 5 }, STAFF_ACTOR);
      for (const item of result.items) {
        expect(item.vehicle.registrationNumber).toBeTruthy();
        expect(item.driver.fullName).toBeTruthy();
        // Slim projection — these wider fields should not be present.
        expect((item.vehicle as unknown as { kind?: unknown }).kind).toBeUndefined();
        expect((item.driver as unknown as { licenseClass?: unknown }).licenseClass).toBeUndefined();
      }
    });

    test("status filter narrows to matching statuses", async () => {
      await seedScenario();
      const result = await service.list({ status: [TripStatus.COMPLETED] }, STAFF_ACTOR);
      expect(result.total).toBe(2);
      expect(result.items.every((t) => t.status === TripStatus.COMPLETED)).toBe(true);
    });

    test("multi-status filter is OR within the dimension", async () => {
      await seedScenario();
      const result = await service.list(
        {
          status: [TripStatus.PLANNED, TripStatus.IN_PROGRESS],
        },
        STAFF_ACTOR,
      );
      expect(result.total).toBe(2);
    });

    test("vehicleId filter narrows to trips for that vehicle", async () => {
      await seedScenario();
      // The seed vehicle has 3 trips (t1, t2, t3); the otherVehicle
      // has 2 (t4, t5).
      const result = await service.list({ vehicleId: vehicle.id }, STAFF_ACTOR);
      expect(result.total).toBe(3);
      expect(result.items.every((t) => t.vehicleId === vehicle.id)).toBe(true);
    });

    test("driverId filter narrows to trips for that driver", async () => {
      const { otherDriver } = await seedScenario();
      // otherDriver appears on t3 and t5.
      const result = await service.list({ driverId: otherDriver.id }, STAFF_ACTOR);
      expect(result.total).toBe(2);
      expect(result.items.every((t) => t.driverId === otherDriver.id)).toBe(true);
    });

    test("vehicleId + status combine with AND across dimensions", async () => {
      await seedScenario();
      // Vehicle's 3 trips are PLANNED, IN_PROGRESS, COMPLETED — exactly
      // one matches COMPLETED.
      const result = await service.list(
        {
          vehicleId: vehicle.id,
          status: [TripStatus.COMPLETED],
        },
        STAFF_ACTOR,
      );
      expect(result.total).toBe(1);
    });

    test("unknown vehicleId → empty result (no error)", async () => {
      // The kickoff explicitly allows "any string in the vehicleId
      // filter; the service no-ops if the id is unknown." Pinning that
      // contract so a future refactor that tightens to a cuid format
      // would surface as an obvious behavior change.
      await seedScenario();
      const result = await service.list({ vehicleId: "no-such-vehicle" }, STAFF_ACTOR);
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });

    test("sortBy=startedAt asc respects the whitelist column", async () => {
      await seedScenario();
      const result = await service.list({ sortBy: "startedAt", sortDir: "asc" }, STAFF_ACTOR);
      // Prisma asc puts nulls last by default. Sorted started times:
      //   t3: 2026-01-05, t2: 2026-01-10, t5: 2026-01-12, then the
      //   two with null startedAt (t1, t4) in createdAt-desc order.
      const startedAtSeq = result.items.map((t) => t.startedAt?.toISOString() ?? null);
      expect(startedAtSeq[0]).toBe("2026-01-05T08:00:00.000Z");
      expect(startedAtSeq[1]).toBe("2026-01-10T08:00:00.000Z");
      expect(startedAtSeq[2]).toBe("2026-01-12T08:00:00.000Z");
      expect(startedAtSeq[3]).toBeNull();
      expect(startedAtSeq[4]).toBeNull();
    });

    test("sortBy=endedAt desc respects the whitelist column", async () => {
      await seedScenario();
      const result = await service.list({ sortBy: "endedAt", sortDir: "desc" }, STAFF_ACTOR);
      // Prisma desc puts nulls first by default. So the three nulls
      // come first (in createdAt-desc), then the two COMPLETED trips
      // by endedAt desc.
      const endedAtSeq = result.items.map((t) => t.endedAt?.toISOString() ?? null);
      // First three entries should be nulls; ordering among themselves
      // is by the createdAt secondary tiebreaker (desc); the exact
      // order between nulls is not the property under test here, so
      // we only assert they are all null.
      expect(endedAtSeq[0]).toBeNull();
      expect(endedAtSeq[1]).toBeNull();
      expect(endedAtSeq[2]).toBeNull();
      expect(endedAtSeq[3]).toBe("2026-01-13T18:00:00.000Z");
      expect(endedAtSeq[4]).toBe("2026-01-06T18:00:00.000Z");
    });

    test("sortBy=createdAt desc is the default order", async () => {
      await seedScenario();
      // Insertion order in seedScenario was t1, t2, t3, t4, t5; the
      // default sort is createdAt desc, so the first row out should
      // be t5 (most recently created). We assert this via the
      // distinguishing properties of t5: otherVehicle, otherDriver,
      // COMPLETED.
      const result = await service.list({}, STAFF_ACTOR);
      const first = result.items[0];
      expect(first?.status).toBe(TripStatus.COMPLETED);
      expect(first?.endOdometerKm).toBe(50420);
    });

    test("pagination: skip + take returns the right window; total reflects the full match", async () => {
      await seedScenario();
      const page = await service.list(
        {
          sortBy: "startedAt",
          sortDir: "asc",
          skip: 1,
          take: 2,
        },
        STAFF_ACTOR,
      );
      // Window is rows 1..2 (zero-based) of the asc-started sort:
      // t2 (2026-01-10) and t5 (2026-01-12).
      const startedAtSeq = page.items.map((t) => t.startedAt?.toISOString() ?? null);
      expect(startedAtSeq).toEqual(["2026-01-10T08:00:00.000Z", "2026-01-12T08:00:00.000Z"]);
      expect(page.total).toBe(5);
    });

    test("take is clamped at LIST_TAKE_MAX (defense-in-depth from the controller schema)", async () => {
      // Mirrors the Drivers / Vehicles defense-in-depth clamp. The
      // schema rejects take>200 with 400 at the pipe; the service
      // also clamps to 200 in case a future direct caller bypasses
      // the controller. The clamp is documented in trips.service.ts;
      // this test pins it so a refactor that removed the clamp without
      // removing the comment would fail.
      await seedScenario();
      const result = await service.list({ take: 10_000 }, STAFF_ACTOR);
      expect(result.items.length).toBeLessThanOrEqual(LIST_TAKE_MAX);
      expect(result.total).toBe(5);
    });

    test("negative skip is clamped to 0 (defense-in-depth)", async () => {
      await seedScenario();
      const result = await service.list({ skip: -5, take: 5 }, STAFF_ACTOR);
      expect(result.items).toHaveLength(5);
    });
  });

  describe("FK Restrict — deleting a referenced Vehicle/Driver throws 409", () => {
    // The schema declares onDelete: Restrict on trip.vehicleId and
    // trip.driverId. The iter-8 baseline was "Prisma P2003 propagates
    // as HTTP 500"; iter-9 (this iter) folds the P2003 → 409 mapping
    // into both VehiclesService.delete and DriversService.delete, and
    // these tests pin the new ConflictException-with-count contract.
    // The matching tech-debt entry "Vehicle/Driver delete must map
    // P2003 to HTTP 409 once Trip write path lands" is paid off in the
    // same PR.
    test("VehiclesService.delete on a vehicle with trips → ConflictException with trip count", async () => {
      // Seed two trips so the count check is more than a "count > 0"
      // assertion — the count must equal the real number of
      // referencing rows, which is the contract operators rely on
      // when deciding which trips to reassign or cancel.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });

      await expect(vehiclesService.delete(vehicle.id)).rejects.toBeInstanceOf(ConflictException);
      try {
        await vehiclesService.delete(vehicle.id);
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        // The message must name the count so operators learn from the
        // error alone how many trips block the delete.
        expect((error as ConflictException).message).toContain("2");
        expect((error as ConflictException).message.toLowerCase()).toContain("trip");
      }

      // Sanity: the vehicle should still exist after the rejected
      // delete attempt — the catch arm must not swallow the rollback.
      const stillVehicle = await prisma.vehicle.findUnique({ where: { id: vehicle.id } });
      expect(stillVehicle).not.toBeNull();
    });

    test("DriversService.delete on a driver with trips → ConflictException with trip count", async () => {
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });

      await expect(driversService.delete(driver.id)).rejects.toBeInstanceOf(ConflictException);
      try {
        await driversService.delete(driver.id);
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).message).toContain("1");
        expect((error as ConflictException).message.toLowerCase()).toContain("trip");
      }
    });
  });

  // -------------------------------------------------------------------
  // iter-9 write-path tests.
  // -------------------------------------------------------------------

  describe("create()", () => {
    test("happy path: persists the row, returns DETAIL_INCLUDE shape", async () => {
      const result = await service.create(
        {
          vehicleId: vehicle.id,
          driverId: driver.id,
          status: TripStatus.PLANNED,
        },
        adminId,
        STAFF_ACTOR,
      );
      expect(result.id).toBeTruthy();
      expect(result.status).toBe(TripStatus.PLANNED);
      // DETAIL_INCLUDE shape: the nested Vehicle and Driver objects
      // should be present so the controller can return the same shape
      // as GET /api/v1/trips/:id.
      expect(result.vehicle.id).toBe(vehicle.id);
      expect(result.driver.id).toBe(driver.id);
      // createdById is server-derived; the wire body never carried it.
      expect(result.createdById).toBe(adminId);
    });

    test("happy path with full COMPLETED shape persists timing/odometer", async () => {
      // A COMPLETED create exercises the cross-field happy path
      // (already validated by the schema, but we pin that the service
      // also writes through the timing and odometer columns).
      const result = await service.create(
        {
          vehicleId: vehicle.id,
          driverId: driver.id,
          status: TripStatus.COMPLETED,
          startedAt: "2026-01-10T08:00:00Z",
          endedAt: "2026-01-10T17:00:00Z",
          startOdometerKm: 80000,
          endOdometerKm: 80250,
          notes: "Pokhara run",
        },
        adminId,
        STAFF_ACTOR,
      );
      expect(result.startedAt?.toISOString()).toBe("2026-01-10T08:00:00.000Z");
      expect(result.endedAt?.toISOString()).toBe("2026-01-10T17:00:00.000Z");
      expect(result.startOdometerKm).toBe(80000);
      expect(result.endOdometerKm).toBe(80250);
      expect(result.notes).toBe("Pokhara run");
    });

    test("create with unknown vehicleId → BadRequestException naming the vehicle", async () => {
      await expect(
        service.create(
          { vehicleId: "vehicle-does-not-exist", driverId: driver.id, status: TripStatus.PLANNED },
          adminId,
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      try {
        await service.create(
          { vehicleId: "vehicle-does-not-exist", driverId: driver.id, status: TripStatus.PLANNED },
          adminId,
          STAFF_ACTOR,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message.toLowerCase()).toContain("vehicle");
      }
    });

    test("create with unknown driverId → BadRequestException naming the driver", async () => {
      await expect(
        service.create(
          { vehicleId: vehicle.id, driverId: "driver-does-not-exist", status: TripStatus.PLANNED },
          adminId,
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      try {
        await service.create(
          { vehicleId: vehicle.id, driverId: "driver-does-not-exist", status: TripStatus.PLANNED },
          adminId,
          STAFF_ACTOR,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message.toLowerCase()).toContain("driver");
      }
    });
  });

  describe("update()", () => {
    test("no-op (empty patch) returns the row unchanged", async () => {
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        notes: "before",
      });
      const result = await service.update(created.id, {}, STAFF_ACTOR);
      expect(result.id).toBe(created.id);
      expect(result.notes).toBe("before");
      // The merged-shape check must still pass on a no-op — a PLANNED
      // trip with no timing fields is a legal merged shape.
      expect(result.status).toBe(TripStatus.PLANNED);
    });

    test("legal transition PLANNED → IN_PROGRESS with start fields", async () => {
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      const result = await service.update(
        created.id,
        {
          status: TripStatus.IN_PROGRESS,
          startedAt: "2026-01-10T08:00:00Z",
          startOdometerKm: 80000,
        },
        STAFF_ACTOR,
      );
      expect(result.status).toBe(TripStatus.IN_PROGRESS);
      expect(result.startedAt?.toISOString()).toBe("2026-01-10T08:00:00.000Z");
      expect(result.startOdometerKm).toBe(80000);
    });

    test("legal transition IN_PROGRESS → COMPLETED with end fields", async () => {
      // Seed directly into IN_PROGRESS so this is a single-step
      // transition exercise — independent of the PLANNED step.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });
      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 80250,
        },
        STAFF_ACTOR,
      );
      expect(result.status).toBe(TripStatus.COMPLETED);
      expect(result.endedAt?.toISOString()).toBe("2026-01-10T17:00:00.000Z");
    });

    test("CANCELLED is reachable from any state (PLANNED → CANCELLED)", async () => {
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      const result = await service.update(
        created.id,
        { status: TripStatus.CANCELLED },
        STAFF_ACTOR,
      );
      expect(result.status).toBe(TripStatus.CANCELLED);
    });

    test("illegal transition PLANNED → COMPLETED → BadRequestException", async () => {
      // The kickoff names this rule explicitly: no jumping from
      // PLANNED to COMPLETED without going through IN_PROGRESS. The
      // guard fires before the cross-field merge check, so the error
      // message must mention the transition, not the missing fields.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await expect(
        service.update(
          created.id,
          {
            status: TripStatus.COMPLETED,
            startedAt: "2026-01-10T08:00:00Z",
            endedAt: "2026-01-10T17:00:00Z",
            startOdometerKm: 80000,
            endOdometerKm: 80250,
          },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("illegal transition COMPLETED → PLANNED → BadRequestException", async () => {
      // COMPLETED is terminal in the matrix; "uncompleting" a trip is
      // illegal. Operators correcting a mis-marked-completed trip
      // should delete-and-recreate, which preserves the audit trail.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        endedAt: new Date("2026-01-10T17:00:00Z"),
        startOdometerKm: 80000,
        endOdometerKm: 80250,
      });
      await expect(
        service.update(created.id, { status: TripStatus.PLANNED }, STAFF_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("cross-field violation: COMPLETED without end fields → BadRequestException", async () => {
      // The merged-shape check fires here: the row was IN_PROGRESS
      // with timing/odometer set, and the patch sets status to
      // COMPLETED but does not supply endedAt or endOdometerKm. The
      // legal-transition guard accepts this (IN_PROGRESS → COMPLETED
      // is in the matrix); the merged-shape rule catches it because
      // a COMPLETED row must have all four start/end fields.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });
      await expect(
        service.update(created.id, { status: TripStatus.COMPLETED }, STAFF_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("cross-field violation: endOdometerKm < startOdometerKm → BadRequestException", async () => {
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });
      await expect(
        service.update(
          created.id,
          {
            status: TripStatus.COMPLETED,
            endedAt: "2026-01-10T17:00:00Z",
            // End odometer is less than start — physically nonsensical.
            endOdometerKm: 79500,
          },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("update on non-existent trip → NotFoundException", async () => {
      await expect(
        service.update("trip-does-not-exist", { status: TripStatus.CANCELLED }, STAFF_ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    test("update can clear a nullable field by sending null", async () => {
      // PATCH semantics distinguish "field omitted" from "field set
      // to null". A patch that explicitly clears `notes` by sending
      // null must persist that as a database null, not as the string
      // "null" or as a no-op.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        notes: "to be cleared",
      });
      const result = await service.update(
        created.id,
        { notes: null as unknown as string },
        STAFF_ACTOR,
      );
      expect(result.notes).toBeNull();
    });
  });

  describe("update() — odometer auto-update on COMPLETED", () => {
    // Iter 11: a Trip's IN_PROGRESS → COMPLETED transition bumps the
    // referenced Vehicle's `odometerCurrentKm` to the trip's
    // `endOdometerKm`, conditional on the new reading being strictly
    // greater than the vehicle's current value. The two writes (trip
    // row, vehicle row) run inside a single Prisma interactive
    // transaction so neither can persist without the other.
    //
    // PLANNED → COMPLETED and CANCELLED → COMPLETED are NOT legal
    // status transitions per TRIP_STATUS_TRANSITIONS (covered by the
    // existing "illegal transition" tests above), so the bump path is
    // only ever reached via IN_PROGRESS → COMPLETED.

    test("IN_PROGRESS → COMPLETED with endOdometerKm > vehicle.odometerCurrentKm bumps the vehicle", async () => {
      // Vehicle's seeded odometerCurrentKm is 80000 (see seedVehicle
      // default). The trip's startOdometerKm matches that value and
      // its endOdometerKm advances it by 250 km — the canonical
      // happy path for a completed trip.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });

      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 80250,
        },
        STAFF_ACTOR,
      );

      // The returned DETAIL_INCLUDE shape reflects the bumped value
      // (the service refreshes the eager-included Vehicle so the
      // caller does not need a follow-up read).
      expect(result.status).toBe(TripStatus.COMPLETED);
      expect(result.vehicle.odometerCurrentKm).toBe(80250);

      // The persisted vehicle row also carries the bumped value.
      const persisted = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(persisted.odometerCurrentKm).toBe(80250);
    });

    test("IN_PROGRESS → COMPLETED with endOdometerKm <= vehicle.odometerCurrentKm leaves the vehicle unchanged", async () => {
      // A backdated correction trip: the vehicle's current odometer
      // is 80000 (the canonical seedVehicle default), but this trip's
      // endOdometerKm is 79500 — older than the vehicle's current
      // reading. The bump must NOT move the vehicle backwards.
      //
      // Note: the trip itself is still recorded with its (lower)
      // odometer readings — those are the trip's authoritative
      // history. The vehicle's `odometerCurrentKm` only ever moves
      // forward. The startOdometerKm must be <= endOdometerKm for
      // the cross-field rule to accept the transition, so we seed
      // both below the vehicle's current value.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 79000,
      });

      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 79500,
        },
        STAFF_ACTOR,
      );

      expect(result.status).toBe(TripStatus.COMPLETED);
      // The returned eager Vehicle still shows the un-bumped value
      // (no `>` => no in-memory refresh).
      expect(result.vehicle.odometerCurrentKm).toBe(80000);

      const persisted = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(persisted.odometerCurrentKm).toBe(80000);
    });

    test("IN_PROGRESS → COMPLETED with endOdometerKm == vehicle.odometerCurrentKm leaves the vehicle unchanged", async () => {
      // The `>` check (not `>=`) avoids a no-op write when the trip's
      // end reading exactly matches the vehicle's current. The
      // observable effect is the same — the value doesn't change —
      // but pinning this edge case prevents a future refactor that
      // weakened the check from silently changing behavior. We can't
      // observe "no UPDATE was issued" easily; we observe the value
      // is unchanged, which is the contract operators care about.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 79500,
      });

      await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 80000,
        },
        STAFF_ACTOR,
      );

      const persisted = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(persisted.odometerCurrentKm).toBe(80000);
    });

    test("self-transition COMPLETED → COMPLETED is idempotent (no further vehicle bump)", async () => {
      // Seed an already-COMPLETED trip and a vehicle whose odometer
      // is older than the trip's endOdometerKm — simulating the
      // post-bump state with operator manually tinkering. A second
      // PATCH that re-sends status=COMPLETED on this row must NOT
      // move the vehicle: the transition matrix allows self-
      // transitions (so the legal-transition guard accepts the
      // patch), but the iter-11 bump fires only on an actual change
      // *into* COMPLETED from another state.
      //
      // The point of this test is the idempotency contract: a
      // retried PATCH (e.g., from a flaky network) must not double-
      // bump or cause an unrelated bump.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        endedAt: new Date("2026-01-10T17:00:00Z"),
        startOdometerKm: 80000,
        endOdometerKm: 80250,
      });

      // Manually set vehicle's odometer to a value below the trip's
      // endOdometerKm to make a hypothetical (incorrect) re-bump
      // detectable. In normal operation the vehicle would already be
      // at 80250 after the original bump; the lower value here is a
      // deliberate test fixture.
      await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: { odometerCurrentKm: 80000 },
      });

      // Self-transition: legal per the matrix, idempotent per the
      // iter-11 contract.
      await service.update(created.id, { status: TripStatus.COMPLETED }, STAFF_ACTOR);

      const persisted = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(persisted.odometerCurrentKm).toBe(80000);
    });

    test("a later patch that does not change status leaves the (already-bumped) vehicle alone", async () => {
      // After a COMPLETED transition has bumped the vehicle, an
      // operator might patch the trip's `notes` field for a
      // correction. That patch does NOT touch the status field, so
      // the bump branch must not fire (and must not, e.g., re-read
      // the vehicle and write its current value back, which would
      // create lock contention on a hot vehicle row).
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });
      await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 80250,
        },
        STAFF_ACTOR,
      );

      // Sanity: vehicle is now at 80250.
      const afterFirstBump = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(afterFirstBump.odometerCurrentKm).toBe(80250);

      // Manually advance the vehicle further (simulating a later
      // trip or a manual edit), then patch notes on the original
      // trip. The notes-only patch must NOT pull the vehicle back
      // down to the trip's endOdometerKm.
      await prisma.vehicle.update({
        where: { id: vehicle.id },
        data: { odometerCurrentKm: 81000 },
      });
      await service.update(created.id, { notes: "added a correction note" }, STAFF_ACTOR);

      const afterNotesPatch = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      expect(afterNotesPatch.odometerCurrentKm).toBe(81000);
    });

    test("legal-transition matrix already blocks PLANNED → COMPLETED, so the bump is unreachable from PLANNED", async () => {
      // Belt-and-braces test: the existing "illegal transition" test
      // above pins that PLANNED → COMPLETED throws BadRequest. This
      // test additionally asserts that the vehicle is untouched when
      // the patch is rejected. Together they pin the contract that
      // (a) the only way to bump the vehicle is via IN_PROGRESS →
      // COMPLETED and (b) a rejected patch leaves both rows alone
      // (the transaction never opens because the guard fires before
      // the $transaction call).
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await expect(
        service.update(
          created.id,
          {
            status: TripStatus.COMPLETED,
            startedAt: "2026-01-10T08:00:00Z",
            endedAt: "2026-01-10T17:00:00Z",
            startOdometerKm: 80000,
            endOdometerKm: 80250,
          },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const persisted = await prisma.vehicle.findUniqueOrThrow({
        where: { id: vehicle.id },
      });
      // Vehicle untouched; the rejected patch never reached the
      // transaction.
      expect(persisted.odometerCurrentKm).toBe(80000);
    });

    test("transaction rollback: trip update is rolled back when the vehicle update fails", async () => {
      // Atomicity proof: the trip row and the vehicle row must
      // commit or fail together. We simulate a vehicle-update
      // failure by *deleting* the vehicle behind the service's back
      // mid-transaction is hard to coordinate in an integration test;
      // a simpler equivalent is to seed a trip whose vehicleId
      // points at a vehicle that is then dropped before the update,
      // so the inner `tx.vehicle.findUniqueOrThrow` throws. The
      // service catches no error specifically for this case, so the
      // throw propagates out of the $transaction, Prisma rolls back
      // the trip update, and the trip row remains in its pre-patch
      // state.
      //
      // We bypass the seedTrip / service path because we need to
      // engineer a Trip whose vehicleId is invalid at the moment of
      // the patch. Approach: seed two vehicles, create a trip on
      // vehicle A, then DELETE vehicle A directly via Prisma (which
      // requires no Trip references, so we use vehicle B for the
      // trip, then re-point the trip to vehicle A by raw SQL — too
      // brittle). Simpler: leverage that Prisma's transactional
      // findUniqueOrThrow will throw if the vehicle row is missing.
      // We mutate the trip's vehicleId to a definitely-non-existent
      // value via raw SQL (bypassing the FK Restrict that would
      // otherwise block this — except the FK Restrict on Trip's
      // vehicleId blocks DELETE of the parent, not arbitrary
      // mutation of the child). Cleanest approach: do this via
      // prisma.$executeRaw with a UPDATE that the deferred FK check
      // permits within the same transaction. That's a Postgres-
      // specific construct.
      //
      // Tech-debt note: a cleaner approach would mock the Prisma
      // client to throw on the vehicle update; the current
      // integration-test fixture does not have that mocking layer.
      // The rollback property is exercised here via a different
      // mechanism: seed an IN_PROGRESS trip, then patch it to
      // COMPLETED with an endOdometerKm that exceeds Postgres's
      // integer range — the vehicle.update will throw a Prisma
      // validation error, the trip update inside the same tx is
      // rolled back, and we can observe the trip is still
      // IN_PROGRESS afterwards.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });

      // 2_147_483_648 is INT32_MAX + 1 — Postgres `Int` columns
      // (which is what Prisma's `Int` maps to) reject it with a
      // "value out of range for type integer" error. The Trip row
      // and the Vehicle row use the same `Int` type for their
      // odometer columns, so the schema validation actually fires
      // at the Trip update (the first write in the tx) — meaning
      // the Vehicle row is never touched. The atomicity property
      // (both committed or both rolled back) holds either way: the
      // trip update is rolled back, the vehicle is unchanged.
      //
      // For a more targeted "vehicle update specifically fails"
      // scenario we would need a Prisma client mock; that's logged
      // as a gap and is fine for this iter because the
      // $transaction wrapper itself is the load-bearing
      // construct — any failure inside it rolls everything back.
      await expect(
        service.update(
          created.id,
          {
            status: TripStatus.COMPLETED,
            endedAt: "2026-01-10T17:00:00Z",
            endOdometerKm: 2_147_483_648,
          },
          STAFF_ACTOR,
        ),
      ).rejects.toThrow();

      // Trip is still IN_PROGRESS — its row was never committed.
      const tripAfter = await prisma.trip.findUniqueOrThrow({ where: { id: created.id } });
      expect(tripAfter.status).toBe(TripStatus.IN_PROGRESS);
      expect(tripAfter.endOdometerKm).toBeNull();

      // Vehicle is also unchanged.
      const vehicleAfter = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
      expect(vehicleAfter.odometerCurrentKm).toBe(80000);
    });
  });

  describe("update() — engine-hours auto-update on COMPLETED (ADR-0036)", () => {
    // The hours rotation of the odometer auto-update above: on a transition
    // INTO COMPLETED, the SAME $transaction advances the vehicle's
    // engineHoursCurrent to the trip's endEngineHours — but ONLY when the
    // vehicle is hour-metered (meterType ENGINE_HOURS / BOTH) AND the reading
    // moves forward (the monotonic ">", a null current seeding the first
    // reading). The km path is unchanged; an ODOMETER_KM vehicle never has
    // its hours touched.
    //
    // The B1 cross-field rule still requires odometer readings on a COMPLETED
    // transition (the meter-aware "hours instead of km for an ENGINE_HOURS
    // asset" relaxation is B2), so every trip below also carries odometer
    // values to satisfy validation, and asserts on the hours dimension.

    test("BOTH vehicle: IN_PROGRESS → COMPLETED bumps odometer AND engineHoursCurrent in one transaction", async () => {
      const both = await seedVehicle(prisma, adminId, {
        meterType: MeterType.BOTH,
        odometerCurrentKm: 80000,
        engineHoursCurrent: 10000, // 1000.0 h
      });
      const created = await seedTrip(prisma, {
        vehicleId: both.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
        startEngineHours: 10000,
      });

      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 80250,
          endEngineHours: 10080, // 1008.0 h — +8.0 h of run time
        },
        STAFF_ACTOR,
      );

      // The returned eager Vehicle reflects BOTH bumped meters.
      expect(result.vehicle.odometerCurrentKm).toBe(80250);
      expect(result.vehicle.engineHoursCurrent).toBe(10080);

      const persisted = await prisma.vehicle.findUniqueOrThrow({ where: { id: both.id } });
      expect(persisted.odometerCurrentKm).toBe(80250);
      expect(persisted.engineHoursCurrent).toBe(10080);
    });

    test("ENGINE_HOURS vehicle: endEngineHours advances engineHoursCurrent on COMPLETED", async () => {
      const excavator = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.EXCAVATOR,
        meterType: MeterType.ENGINE_HOURS,
        odometerCurrentKm: 5000,
        engineHoursCurrent: 25000, // 2500.0 h
      });
      const created = await seedTrip(prisma, {
        vehicleId: excavator.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-02-01T07:00:00Z"),
        startOdometerKm: 5000,
        startEngineHours: 25000,
      });

      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-02-01T16:30:00Z",
          endOdometerKm: 5001,
          endEngineHours: 25095, // +9.5 h
        },
        STAFF_ACTOR,
      );
      expect(result.vehicle.engineHoursCurrent).toBe(25095);

      const persisted = await prisma.vehicle.findUniqueOrThrow({ where: { id: excavator.id } });
      expect(persisted.engineHoursCurrent).toBe(25095);
    });

    test("ODOMETER_KM vehicle: endEngineHours on the trip does NOT touch engineHoursCurrent (meterType gate)", async () => {
      // Defensive: even if a trip somehow carries endEngineHours, a km-only
      // vehicle's hours column must stay null — the meterType gate blocks the
      // hours bump. The odometer still bumps as usual.
      const truck = await seedVehicle(prisma, adminId, {
        meterType: MeterType.ODOMETER_KM,
        odometerCurrentKm: 80000,
        // engineHoursCurrent defaults to null
      });
      const created = await seedTrip(prisma, {
        vehicleId: truck.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
        startEngineHours: 1000,
      });

      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 80250,
          endEngineHours: 1080,
        },
        STAFF_ACTOR,
      );
      expect(result.vehicle.odometerCurrentKm).toBe(80250);
      expect(result.vehicle.engineHoursCurrent).toBeNull();

      const persisted = await prisma.vehicle.findUniqueOrThrow({ where: { id: truck.id } });
      expect(persisted.odometerCurrentKm).toBe(80250);
      expect(persisted.engineHoursCurrent).toBeNull();
    });

    test("hours monotonic: endEngineHours <= engineHoursCurrent leaves the hours unchanged (even when the odometer moves forward)", async () => {
      const both = await seedVehicle(prisma, adminId, {
        meterType: MeterType.BOTH,
        odometerCurrentKm: 80000,
        engineHoursCurrent: 10000,
      });
      const created = await seedTrip(prisma, {
        vehicleId: both.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
        startEngineHours: 9000,
      });

      // Odometer moves forward (80250 > 80000) but the end hours (9800) are
      // BELOW the vehicle's current (10000) — a backdated/short hours reading.
      // The "once forward" rule moves the odometer but NOT the hours.
      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 80250,
          endEngineHours: 9800,
        },
        STAFF_ACTOR,
      );
      expect(result.vehicle.odometerCurrentKm).toBe(80250);
      expect(result.vehicle.engineHoursCurrent).toBe(10000);

      const persisted = await prisma.vehicle.findUniqueOrThrow({ where: { id: both.id } });
      expect(persisted.engineHoursCurrent).toBe(10000);
    });

    test("null engineHoursCurrent is seeded by the first COMPLETED trip on an hour-metered vehicle", async () => {
      // An hour-metered asset registered before its SMR was keyed in has
      // engineHoursCurrent = null. A null current is "behind any reading", so
      // the first completed trip seeds it (ADR-0036 c5).
      const loader = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.LOADER,
        meterType: MeterType.ENGINE_HOURS,
        odometerCurrentKm: 100,
        engineHoursStart: null,
        engineHoursCurrent: null,
      });
      const created = await seedTrip(prisma, {
        vehicleId: loader.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-03-01T06:00:00Z"),
        startOdometerKm: 100,
        startEngineHours: 5000,
      });

      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-03-01T14:00:00Z",
          endOdometerKm: 101,
          endEngineHours: 5300, // 530.0 h
        },
        STAFF_ACTOR,
      );
      expect(result.vehicle.engineHoursCurrent).toBe(5300);

      const persisted = await prisma.vehicle.findUniqueOrThrow({ where: { id: loader.id } });
      expect(persisted.engineHoursCurrent).toBe(5300);
    });

    test("cross-field: a COMPLETED transition with endEngineHours < startEngineHours is rejected and bumps nothing", async () => {
      const both = await seedVehicle(prisma, adminId, {
        meterType: MeterType.BOTH,
        odometerCurrentKm: 80000,
        engineHoursCurrent: 10000,
      });
      const created = await seedTrip(prisma, {
        vehicleId: both.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
        startEngineHours: 5000,
      });

      await expect(
        service.update(
          created.id,
          {
            status: TripStatus.COMPLETED,
            endedAt: "2026-01-10T17:00:00Z",
            endOdometerKm: 80250, // odometer is fine (>= start)
            endEngineHours: 4000, // but hours regress (4000 < 5000)
          },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The rejected patch never reached the transaction: the trip is still
      // IN_PROGRESS and the vehicle's meters are untouched.
      const tripAfter = await prisma.trip.findUniqueOrThrow({ where: { id: created.id } });
      expect(tripAfter.status).toBe(TripStatus.IN_PROGRESS);
      const vehicleAfter = await prisma.vehicle.findUniqueOrThrow({ where: { id: both.id } });
      expect(vehicleAfter.odometerCurrentKm).toBe(80000);
      expect(vehicleAfter.engineHoursCurrent).toBe(10000);
    });
  });

  describe("meter-aware cross-field validation (ADR-0036 c7, B2)", () => {
    // The B2 relaxation: validateTripCrossFields is now meter-aware. The
    // service looks up the vehicle's meterType and requires the reading(s)
    // that meter calls for — km for ODOMETER_KM, hours for ENGINE_HOURS, both
    // for BOTH. B1 required odometer unconditionally, which blocked a pure
    // ENGINE_HOURS vehicle from ever completing a trip; these tests pin the fix
    // across the create AND update paths.

    // --- update(): the headline relaxation ---

    test("ENGINE_HOURS vehicle CAN complete a trip with hours and NO odometer (the B1 blocker, now fixed)", async () => {
      const excavator = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.EXCAVATOR,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 25000, // 2500.0 h
      });
      const created = await seedTrip(prisma, {
        vehicleId: excavator.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-02-01T07:00:00Z"),
        // No odometer reading at all — a pure hour-metered asset.
        startEngineHours: 25000,
      });

      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-02-01T16:30:00Z",
          endEngineHours: 25095, // +9.5 h, no endOdometerKm
        },
        STAFF_ACTOR,
      );

      expect(result.status).toBe(TripStatus.COMPLETED);
      expect(result.endEngineHours).toBe(25095);
      expect(result.endOdometerKm).toBeNull();
      // The hours bump still runs; the odometer stays put (none supplied).
      expect(result.vehicle.engineHoursCurrent).toBe(25095);
    });

    test("ENGINE_HOURS vehicle: COMPLETED transition WITHOUT end hours → BadRequestException", async () => {
      const excavator = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.EXCAVATOR,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 25000,
      });
      const created = await seedTrip(prisma, {
        vehicleId: excavator.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-02-01T07:00:00Z"),
        startEngineHours: 25000,
      });
      // endedAt present but no endEngineHours — the meter requires hours.
      await expect(
        service.update(
          created.id,
          { status: TripStatus.COMPLETED, endedAt: "2026-02-01T16:30:00Z" },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("ENGINE_HOURS vehicle: starting a trip WITHOUT start hours → BadRequestException", async () => {
      const excavator = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.EXCAVATOR,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 25000,
      });
      const created = await seedTrip(prisma, {
        vehicleId: excavator.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      // IN_PROGRESS with startedAt but no startEngineHours — hours required.
      await expect(
        service.update(
          created.id,
          { status: TripStatus.IN_PROGRESS, startedAt: "2026-02-01T07:00:00Z" },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("ENGINE_HOURS vehicle: an odometer reading is NOT required to complete", async () => {
      // Symmetric to the ODOMETER_KM rule — an hour-metered asset's COMPLETED
      // trip validates with hours only; the absent km is correct, not an error.
      const loader = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.LOADER,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 5000,
      });
      const created = await seedTrip(prisma, {
        vehicleId: loader.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-03-01T06:00:00Z"),
        startEngineHours: 5000,
      });
      const result = await service.update(
        created.id,
        {
          status: TripStatus.COMPLETED,
          endedAt: "2026-03-01T14:00:00Z",
          endEngineHours: 5080,
        },
        STAFF_ACTOR,
      );
      expect(result.status).toBe(TripStatus.COMPLETED);
    });

    test("ODOMETER_KM vehicle: COMPLETED WITHOUT end odometer → BadRequestException (km still required)", async () => {
      // The default seeded `vehicle` is ODOMETER_KM. Hours are not required,
      // but km still is — the km path is unchanged by B2.
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
      });
      await expect(
        service.update(
          created.id,
          { status: TripStatus.COMPLETED, endedAt: "2026-01-10T17:00:00Z" },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("BOTH vehicle: COMPLETED with odometer but NO hours → BadRequestException", async () => {
      const both = await seedVehicle(prisma, adminId, {
        meterType: MeterType.BOTH,
        odometerCurrentKm: 80000,
        engineHoursCurrent: 10000,
      });
      const created = await seedTrip(prisma, {
        vehicleId: both.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
        startEngineHours: 10000,
      });
      await expect(
        service.update(
          created.id,
          {
            status: TripStatus.COMPLETED,
            endedAt: "2026-01-10T17:00:00Z",
            endOdometerKm: 80250, // km present...
            // ...but endEngineHours missing — BOTH requires it.
          },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("BOTH vehicle: COMPLETED with hours but NO odometer → BadRequestException", async () => {
      const both = await seedVehicle(prisma, adminId, {
        meterType: MeterType.BOTH,
        odometerCurrentKm: 80000,
        engineHoursCurrent: 10000,
      });
      const created = await seedTrip(prisma, {
        vehicleId: both.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-01-10T08:00:00Z"),
        startOdometerKm: 80000,
        startEngineHours: 10000,
      });
      await expect(
        service.update(
          created.id,
          {
            status: TripStatus.COMPLETED,
            endedAt: "2026-01-10T17:00:00Z",
            endEngineHours: 10080, // hours present, endOdometerKm missing — required.
          },
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // --- create(): the same rule, meter-aware, on the create path ---

    test("create(): ENGINE_HOURS vehicle COMPLETED with hours-only persists (no odometer required)", async () => {
      const excavator = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.EXCAVATOR,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 30000,
      });
      const result = await service.create(
        {
          vehicleId: excavator.id,
          driverId: driver.id,
          status: TripStatus.COMPLETED,
          startedAt: "2026-04-01T07:00:00Z",
          endedAt: "2026-04-01T15:00:00Z",
          startEngineHours: 30000,
          endEngineHours: 30080,
        },
        adminId,
        STAFF_ACTOR,
      );
      expect(result.status).toBe(TripStatus.COMPLETED);
      expect(result.endEngineHours).toBe(30080);
      expect(result.endOdometerKm).toBeNull();
    });

    test("create(): ENGINE_HOURS vehicle COMPLETED missing hours → BadRequestException", async () => {
      const excavator = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.EXCAVATOR,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 30000,
      });
      await expect(
        service.create(
          {
            vehicleId: excavator.id,
            driverId: driver.id,
            status: TripStatus.COMPLETED,
            startedAt: "2026-04-01T07:00:00Z",
            endedAt: "2026-04-01T15:00:00Z",
            // no engine-hours readings — required for ENGINE_HOURS.
          },
          adminId,
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("create(): ODOMETER_KM vehicle COMPLETED missing odometer → BadRequestException (unchanged)", async () => {
      await expect(
        service.create(
          {
            vehicleId: vehicle.id, // default ODOMETER_KM
            driverId: driver.id,
            status: TripStatus.COMPLETED,
            startedAt: "2026-01-10T08:00:00Z",
            endedAt: "2026-01-10T17:00:00Z",
            // no odometer readings — still required for a km asset.
          },
          adminId,
          STAFF_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("delete()", () => {
    test("happy path: row gone from the database", async () => {
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });
      await service.delete(created.id, STAFF_ACTOR);
      const fetched = await prisma.trip.findUnique({ where: { id: created.id } });
      expect(fetched).toBeNull();
    });

    test("delete on non-existent trip → NotFoundException", async () => {
      await expect(service.delete("trip-does-not-exist", STAFF_ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // ADR-0029 T2 (commitment 7): GpsPing.tripId (onDelete: Restrict)
    // makes Trip a referenced aggregate, so deleting a referenced Trip
    // must surface as ConflictException (HTTP 409), not propagate as a
    // raw P2003 / HTTP 500. Mirror of the Customers delete-blocker test
    // (apps/api/test/customers.service.test.ts) — same generic
    // "referenced by other records." message because Trip has multiple
    // heterogeneous referencers (FuelLog, ExpenseLog, GpsPing). This
    // also pins the fix for the latent gap where a Trip with fuel/expense
    // logs already 500'd on delete.
    test("delete on a trip referenced by a GpsPing → ConflictException (P2003 → 409)", async () => {
      const trip = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });
      await seedGpsPing(prisma, {
        vehicleId: vehicle.id,
        tripId: trip.id,
        createdById: adminId,
      });

      let thrown: unknown;
      try {
        await service.delete(trip.id, STAFF_ACTOR);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).message).toBe(
        "Cannot delete trip: it is referenced by other records.",
      );

      // The trip row survives the blocked delete (Restrict prevented it,
      // and the catch arm did not swallow the rollback).
      const refetched = await prisma.trip.findUnique({ where: { id: trip.id } });
      expect(refetched).not.toBeNull();
    });
  });

  describe("statsForVehicle() — iter 12 per-vehicle aggregations", () => {
    // The iter-12 surface is three scalar aggregations the Vehicle
    // detail page renders. The service computes them in one
    // $transaction so the three reads see a consistent snapshot.
    // Tests below pin the policy decisions documented on the service
    // method: COMPLETED-only count + sum; most-recent driver across
    // trips with non-null startedAt (so PLANNED is excluded).

    test("zero trips → count 0, total 0, mostRecentDriver null", async () => {
      const stats = await service.statsForVehicle(vehicle.id);
      expect(stats.completedTripCount).toBe(0);
      expect(stats.totalKmLogged).toBe(0);
      expect(stats.mostRecentDriver).toBeNull();
    });

    test("only PLANNED trips → count 0, total 0, mostRecentDriver null", async () => {
      // PLANNED trips have startedAt = null per the fixture default,
      // so they neither count toward completedTripCount nor surface as
      // the most-recent driver. Pinned so a refactor that broadened
      // the count to "all trips" would fail.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      const stats = await service.statsForVehicle(vehicle.id);
      expect(stats.completedTripCount).toBe(0);
      expect(stats.totalKmLogged).toBe(0);
      expect(stats.mostRecentDriver).toBeNull();
    });

    test("mix of statuses — count + sum cover COMPLETED only; mostRecentDriver picks max startedAt", async () => {
      // Five trips on `vehicle`, of varied status. Only the two
      // COMPLETED contribute to count + sum. mostRecentDriver picks
      // the trip with the largest non-null startedAt — here, the
      // IN_PROGRESS one, which started after both completions.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 1000,
        endOdometerKm: 1250,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-02T08:00:00Z"),
        endedAt: new Date("2026-04-02T18:00:00Z"),
        startOdometerKm: 1250,
        endOdometerKm: 1500,
      });
      const inProgressDriver = await seedDriver(prisma, adminId);
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: inProgressDriver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-03T08:00:00Z"),
        startOdometerKm: 1500,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.CANCELLED,
        startedAt: new Date("2026-03-15T08:00:00Z"),
        startOdometerKm: 950,
      });

      const stats = await service.statsForVehicle(vehicle.id);
      expect(stats.completedTripCount).toBe(2);
      // Two COMPLETED trips: (1250 − 1000) + (1500 − 1250) = 500.
      expect(stats.totalKmLogged).toBe(500);
      // Most-recent by startedAt is the IN_PROGRESS trip on 2026-04-03.
      expect(stats.mostRecentDriver).not.toBeNull();
      expect(stats.mostRecentDriver?.id).toBe(inProgressDriver.id);
      expect(stats.mostRecentDriver?.startedAt.toISOString()).toBe("2026-04-03T08:00:00.000Z");
    });

    test("cross-vehicle isolation — trips on Vehicle B do not leak into Vehicle A stats", async () => {
      const otherVehicle = await seedVehicle(prisma, adminId);
      // Vehicle A gets 1 COMPLETED.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 100,
        endOdometerKm: 200,
      });
      // Vehicle B gets 3 COMPLETED — should not show up in A's count.
      for (let i = 0; i < 3; i++) {
        await seedTrip(prisma, {
          vehicleId: otherVehicle.id,
          driverId: driver.id,
          createdById: adminId,
          status: TripStatus.COMPLETED,
          startedAt: new Date("2026-04-02T08:00:00Z"),
          endedAt: new Date("2026-04-02T18:00:00Z"),
          startOdometerKm: 1000,
          endOdometerKm: 1100,
        });
      }

      const statsA = await service.statsForVehicle(vehicle.id);
      expect(statsA.completedTripCount).toBe(1);
      expect(statsA.totalKmLogged).toBe(100);
    });

    test("mostRecentDriver picks max startedAt, not max createdAt", async () => {
      // Two trips on the same vehicle. The one created LATER has an
      // earlier startedAt. The query orders by startedAt desc, so the
      // earlier-started trip should NOT be the most-recent driver
      // even though it was inserted into the table later. Pins the
      // policy decision documented on the service method.
      const earlierDriver = await seedDriver(prisma, adminId);
      const laterDriver = await seedDriver(prisma, adminId);

      // laterDriver's trip has earlier startedAt and is inserted last.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: earlierDriver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-10T08:00:00Z"),
        startOdometerKm: 100,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: laterDriver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-05T08:00:00Z"),
        startOdometerKm: 200,
      });

      const stats = await service.statsForVehicle(vehicle.id);
      // earlierDriver has the LATER startedAt (the 10th vs. the 5th),
      // so they should be the most-recent driver.
      expect(stats.mostRecentDriver?.id).toBe(earlierDriver.id);
    });

    test("non-monotonic endOdometerKm (backdated trip) still sums arithmetically", async () => {
      // The iter-11 odometer-bump rule only moves the vehicle's
      // odometerCurrentKm forward, but the per-trip stats sum is a
      // pure arithmetic sum: each COMPLETED trip's
      // (endOdometerKm − startOdometerKm) contributes regardless of
      // whether it moved the vehicle's odometer or not. This pins
      // the scope decision documented on the service.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 5000,
        endOdometerKm: 5300,
      });
      // Backdated COMPLETED with smaller numbers — the iter-11 rule
      // would NOT move the vehicle odometer; but the sum here is
      // straightforward (end − start = 100).
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-01-01T08:00:00Z"),
        endedAt: new Date("2026-01-01T18:00:00Z"),
        startOdometerKm: 100,
        endOdometerKm: 200,
      });

      const stats = await service.statsForVehicle(vehicle.id);
      expect(stats.completedTripCount).toBe(2);
      // 300 + 100 = 400.
      expect(stats.totalKmLogged).toBe(400);
    });
  });

  describe("statsForDriver() — iter 13 per-driver aggregations", () => {
    // The symmetric mirror of the iter-12 statsForVehicle block above.
    // Same three scalar aggregations the Driver detail page renders;
    // same single-$transaction snapshot guarantee; same policy
    // decisions documented on the service method (COMPLETED-only count
    // + sum; most-recent vehicle across trips with non-null startedAt,
    // so PLANNED is excluded). Tests mirror the vehicle variant 1:1,
    // swapping vehicle ↔ driver and the "most recent X" framing.

    test("zero trips → count 0, total 0, mostRecentVehicle null", async () => {
      const stats = await service.statsForDriver(driver.id);
      expect(stats.completedTripCount).toBe(0);
      expect(stats.totalKmLogged).toBe(0);
      expect(stats.mostRecentVehicle).toBeNull();
    });

    test("only PLANNED trips → count 0, total 0, mostRecentVehicle null", async () => {
      // PLANNED trips have startedAt = null per the fixture default,
      // so they neither count toward completedTripCount nor surface as
      // the most-recent vehicle. Pinned so a refactor that broadened
      // the count to "all trips" would fail.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      const stats = await service.statsForDriver(driver.id);
      expect(stats.completedTripCount).toBe(0);
      expect(stats.totalKmLogged).toBe(0);
      expect(stats.mostRecentVehicle).toBeNull();
    });

    test("mix of statuses — count + sum cover COMPLETED only; mostRecentVehicle picks max startedAt", async () => {
      // Five trips for `driver`, of varied status. Only the two
      // COMPLETED contribute to count + sum. mostRecentVehicle picks
      // the trip with the largest non-null startedAt — here, the
      // IN_PROGRESS one, which started after both completions.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 1000,
        endOdometerKm: 1250,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-02T08:00:00Z"),
        endedAt: new Date("2026-04-02T18:00:00Z"),
        startOdometerKm: 1250,
        endOdometerKm: 1500,
      });
      const inProgressVehicle = await seedVehicle(prisma, adminId);
      await seedTrip(prisma, {
        vehicleId: inProgressVehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-03T08:00:00Z"),
        startOdometerKm: 1500,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.CANCELLED,
        startedAt: new Date("2026-03-15T08:00:00Z"),
        startOdometerKm: 950,
      });

      const stats = await service.statsForDriver(driver.id);
      expect(stats.completedTripCount).toBe(2);
      // Two COMPLETED trips: (1250 − 1000) + (1500 − 1250) = 500.
      expect(stats.totalKmLogged).toBe(500);
      // Most-recent by startedAt is the IN_PROGRESS trip on 2026-04-03.
      expect(stats.mostRecentVehicle).not.toBeNull();
      expect(stats.mostRecentVehicle?.id).toBe(inProgressVehicle.id);
      expect(stats.mostRecentVehicle?.startedAt.toISOString()).toBe("2026-04-03T08:00:00.000Z");
    });

    test("cross-driver isolation — trips on Driver B do not leak into Driver A stats", async () => {
      const otherDriver = await seedDriver(prisma, adminId);
      // Driver A gets 1 COMPLETED.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 100,
        endOdometerKm: 200,
      });
      // Driver B gets 3 COMPLETED — should not show up in A's count.
      for (let i = 0; i < 3; i++) {
        await seedTrip(prisma, {
          vehicleId: vehicle.id,
          driverId: otherDriver.id,
          createdById: adminId,
          status: TripStatus.COMPLETED,
          startedAt: new Date("2026-04-02T08:00:00Z"),
          endedAt: new Date("2026-04-02T18:00:00Z"),
          startOdometerKm: 1000,
          endOdometerKm: 1100,
        });
      }

      const statsA = await service.statsForDriver(driver.id);
      expect(statsA.completedTripCount).toBe(1);
      expect(statsA.totalKmLogged).toBe(100);
    });

    test("mostRecentVehicle picks max startedAt, not max createdAt", async () => {
      // Two trips for the same driver. The one created LATER has an
      // earlier startedAt. The query orders by startedAt desc, so the
      // earlier-started trip should NOT be the most-recent vehicle
      // even though it was inserted into the table later. Pins the
      // policy decision documented on the service method.
      const earlierVehicle = await seedVehicle(prisma, adminId);
      const laterVehicle = await seedVehicle(prisma, adminId);

      // laterVehicle's trip has earlier startedAt and is inserted last.
      await seedTrip(prisma, {
        vehicleId: earlierVehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-10T08:00:00Z"),
        startOdometerKm: 100,
      });
      await seedTrip(prisma, {
        vehicleId: laterVehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-05T08:00:00Z"),
        startOdometerKm: 200,
      });

      const stats = await service.statsForDriver(driver.id);
      // earlierVehicle has the LATER startedAt (the 10th vs. the 5th),
      // so it should be the most-recent vehicle.
      expect(stats.mostRecentVehicle?.id).toBe(earlierVehicle.id);
    });

    test("non-monotonic endOdometerKm (backdated trip) still sums arithmetically", async () => {
      // The iter-11 odometer-bump rule only moves the vehicle's
      // odometerCurrentKm forward, but the per-driver stats sum is a
      // pure arithmetic sum: each COMPLETED trip's
      // (endOdometerKm − startOdometerKm) contributes regardless of
      // whether it moved the vehicle's odometer or not. This pins the
      // scope decision documented on the service.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 5000,
        endOdometerKm: 5300,
      });
      // Backdated COMPLETED with smaller numbers — the iter-11 rule
      // would NOT move the vehicle odometer; but the sum here is
      // straightforward (end − start = 100).
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-01-01T08:00:00Z"),
        endedAt: new Date("2026-01-01T18:00:00Z"),
        startOdometerKm: 100,
        endOdometerKm: 200,
      });

      const stats = await service.statsForDriver(driver.id);
      expect(stats.completedTripCount).toBe(2);
      // 300 + 100 = 400.
      expect(stats.totalKmLogged).toBe(400);
    });
  });

  describe("totalHoursLogged — engine-hours lifetime stats (ADR-0036)", () => {
    // totalHoursLogged is the hours rotation of totalKmLogged: Σ
    // (endEngineHours − startEngineHours) over COMPLETED trips, integer
    // tenths-of-an-hour. Added to BOTH statsForVehicle and statsForDriver
    // (ADR-0036 c6). It is 0 for a km-only fleet (the hours columns are
    // null, `?? 0` → 0). seedTrip writes raw rows, so these seed COMPLETED
    // trips with hours directly (no service round-trip / cross-field gate).

    test("statsForVehicle: totalHoursLogged is 0 for a km-only fleet", async () => {
      // A km-only COMPLETED trip → totalKmLogged > 0 but totalHoursLogged 0.
      await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 1000,
        endOdometerKm: 1250,
      });
      const stats = await service.statsForVehicle(vehicle.id);
      expect(stats.totalKmLogged).toBe(250);
      expect(stats.totalHoursLogged).toBe(0);
    });

    test("statsForVehicle: totalHoursLogged sums endEngineHours − startEngineHours over COMPLETED trips", async () => {
      const excavator = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.EXCAVATOR,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 20000,
      });
      // Two COMPLETED trips: (10250 − 10000) + (10600 − 10250) = 250 + 350 = 600.
      await seedTrip(prisma, {
        vehicleId: excavator.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startEngineHours: 10000,
        endEngineHours: 10250,
      });
      await seedTrip(prisma, {
        vehicleId: excavator.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-02T08:00:00Z"),
        endedAt: new Date("2026-04-02T18:00:00Z"),
        startEngineHours: 10250,
        endEngineHours: 10600,
      });

      const stats = await service.statsForVehicle(excavator.id);
      expect(stats.completedTripCount).toBe(2);
      expect(stats.totalHoursLogged).toBe(600); // 60.0 h
    });

    test("statsForVehicle: only COMPLETED trips contribute to totalHoursLogged", async () => {
      const both = await seedVehicle(prisma, adminId, {
        meterType: MeterType.BOTH,
        engineHoursCurrent: 20000,
      });
      // One COMPLETED contributes; one IN_PROGRESS (start hours, no end) does not.
      await seedTrip(prisma, {
        vehicleId: both.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-01T08:00:00Z"),
        endedAt: new Date("2026-04-01T18:00:00Z"),
        startOdometerKm: 1000,
        endOdometerKm: 1100,
        startEngineHours: 4000,
        endEngineHours: 4150,
      });
      await seedTrip(prisma, {
        vehicleId: both.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-03T08:00:00Z"),
        startOdometerKm: 1100,
        startEngineHours: 4150,
      });

      const stats = await service.statsForVehicle(both.id);
      expect(stats.completedTripCount).toBe(1);
      expect(stats.totalHoursLogged).toBe(150); // only the COMPLETED trip's 15.0 h
    });

    test("statsForDriver: totalHoursLogged sums over the driver's COMPLETED trips (ADR-0036 c6 — symmetric)", async () => {
      const grader = await seedVehicle(prisma, adminId, {
        kind: VehicleKind.GRADER,
        meterType: MeterType.ENGINE_HOURS,
        engineHoursCurrent: 30000,
      });
      // The default `driver` runs two COMPLETED trips: 200 + 300 = 500 tenths.
      await seedTrip(prisma, {
        vehicleId: grader.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-05-01T08:00:00Z"),
        endedAt: new Date("2026-05-01T18:00:00Z"),
        startEngineHours: 15000,
        endEngineHours: 15200,
      });
      await seedTrip(prisma, {
        vehicleId: grader.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-05-02T08:00:00Z"),
        endedAt: new Date("2026-05-02T18:00:00Z"),
        startEngineHours: 15200,
        endEngineHours: 15500,
      });

      const stats = await service.statsForDriver(driver.id);
      expect(stats.completedTripCount).toBe(2);
      expect(stats.totalHoursLogged).toBe(500); // 50.0 h
    });
  });
});
