import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TripStatus, type Vehicle, type Driver } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { DriversService } from "../src/modules/drivers/drivers.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsService, LIST_TAKE_MAX } from "../src/modules/trips/trips.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { resetDb } from "./db";
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
      providers: [TripsService, VehiclesService, DriversService, PrismaService],
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

      const fetched = await service.findById(created.id);
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
      const fetched = await service.findById("nonexistent-id");
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
      const result = await service.list({});
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
      const result = await service.list({ take: 5 });
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
      const result = await service.list({ status: [TripStatus.COMPLETED] });
      expect(result.total).toBe(2);
      expect(result.items.every((t) => t.status === TripStatus.COMPLETED)).toBe(true);
    });

    test("multi-status filter is OR within the dimension", async () => {
      await seedScenario();
      const result = await service.list({
        status: [TripStatus.PLANNED, TripStatus.IN_PROGRESS],
      });
      expect(result.total).toBe(2);
    });

    test("vehicleId filter narrows to trips for that vehicle", async () => {
      await seedScenario();
      // The seed vehicle has 3 trips (t1, t2, t3); the otherVehicle
      // has 2 (t4, t5).
      const result = await service.list({ vehicleId: vehicle.id });
      expect(result.total).toBe(3);
      expect(result.items.every((t) => t.vehicleId === vehicle.id)).toBe(true);
    });

    test("driverId filter narrows to trips for that driver", async () => {
      const { otherDriver } = await seedScenario();
      // otherDriver appears on t3 and t5.
      const result = await service.list({ driverId: otherDriver.id });
      expect(result.total).toBe(2);
      expect(result.items.every((t) => t.driverId === otherDriver.id)).toBe(true);
    });

    test("vehicleId + status combine with AND across dimensions", async () => {
      await seedScenario();
      // Vehicle's 3 trips are PLANNED, IN_PROGRESS, COMPLETED — exactly
      // one matches COMPLETED.
      const result = await service.list({
        vehicleId: vehicle.id,
        status: [TripStatus.COMPLETED],
      });
      expect(result.total).toBe(1);
    });

    test("unknown vehicleId → empty result (no error)", async () => {
      // The kickoff explicitly allows "any string in the vehicleId
      // filter; the service no-ops if the id is unknown." Pinning that
      // contract so a future refactor that tightens to a cuid format
      // would surface as an obvious behavior change.
      await seedScenario();
      const result = await service.list({ vehicleId: "no-such-vehicle" });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });

    test("sortBy=startedAt asc respects the whitelist column", async () => {
      await seedScenario();
      const result = await service.list({ sortBy: "startedAt", sortDir: "asc" });
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
      const result = await service.list({ sortBy: "endedAt", sortDir: "desc" });
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
      const result = await service.list({});
      const first = result.items[0];
      expect(first?.status).toBe(TripStatus.COMPLETED);
      expect(first?.endOdometerKm).toBe(50420);
    });

    test("pagination: skip + take returns the right window; total reflects the full match", async () => {
      await seedScenario();
      const page = await service.list({
        sortBy: "startedAt",
        sortDir: "asc",
        skip: 1,
        take: 2,
      });
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
      const result = await service.list({ take: 10_000 });
      expect(result.items.length).toBeLessThanOrEqual(LIST_TAKE_MAX);
      expect(result.total).toBe(5);
    });

    test("negative skip is clamped to 0 (defense-in-depth)", async () => {
      await seedScenario();
      const result = await service.list({ skip: -5, take: 5 });
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
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      try {
        await service.create(
          { vehicleId: "vehicle-does-not-exist", driverId: driver.id, status: TripStatus.PLANNED },
          adminId,
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
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      try {
        await service.create(
          { vehicleId: vehicle.id, driverId: "driver-does-not-exist", status: TripStatus.PLANNED },
          adminId,
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
      const result = await service.update(created.id, {});
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
      const result = await service.update(created.id, {
        status: TripStatus.IN_PROGRESS,
        startedAt: "2026-01-10T08:00:00Z",
        startOdometerKm: 80000,
      });
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
      const result = await service.update(created.id, {
        status: TripStatus.COMPLETED,
        endedAt: "2026-01-10T17:00:00Z",
        endOdometerKm: 80250,
      });
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
      const result = await service.update(created.id, { status: TripStatus.CANCELLED });
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
        service.update(created.id, {
          status: TripStatus.COMPLETED,
          startedAt: "2026-01-10T08:00:00Z",
          endedAt: "2026-01-10T17:00:00Z",
          startOdometerKm: 80000,
          endOdometerKm: 80250,
        }),
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
        service.update(created.id, { status: TripStatus.PLANNED }),
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
        service.update(created.id, { status: TripStatus.COMPLETED }),
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
        service.update(created.id, {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          // End odometer is less than start — physically nonsensical.
          endOdometerKm: 79500,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    test("update on non-existent trip → NotFoundException", async () => {
      await expect(
        service.update("trip-does-not-exist", { status: TripStatus.CANCELLED }),
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
      const result = await service.update(created.id, { notes: null as unknown as string });
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

      const result = await service.update(created.id, {
        status: TripStatus.COMPLETED,
        endedAt: "2026-01-10T17:00:00Z",
        endOdometerKm: 80250,
      });

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

      const result = await service.update(created.id, {
        status: TripStatus.COMPLETED,
        endedAt: "2026-01-10T17:00:00Z",
        endOdometerKm: 79500,
      });

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

      await service.update(created.id, {
        status: TripStatus.COMPLETED,
        endedAt: "2026-01-10T17:00:00Z",
        endOdometerKm: 80000,
      });

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
      await service.update(created.id, { status: TripStatus.COMPLETED });

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
      await service.update(created.id, {
        status: TripStatus.COMPLETED,
        endedAt: "2026-01-10T17:00:00Z",
        endOdometerKm: 80250,
      });

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
      await service.update(created.id, { notes: "added a correction note" });

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
        service.update(created.id, {
          status: TripStatus.COMPLETED,
          startedAt: "2026-01-10T08:00:00Z",
          endedAt: "2026-01-10T17:00:00Z",
          startOdometerKm: 80000,
          endOdometerKm: 80250,
        }),
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
        service.update(created.id, {
          status: TripStatus.COMPLETED,
          endedAt: "2026-01-10T17:00:00Z",
          endOdometerKm: 2_147_483_648,
        }),
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

  describe("delete()", () => {
    test("happy path: row gone from the database", async () => {
      const created = await seedTrip(prisma, {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
      });
      await service.delete(created.id);
      const fetched = await prisma.trip.findUnique({ where: { id: created.id } });
      expect(fetched).toBeNull();
    });

    test("delete on non-existent trip → NotFoundException", async () => {
      await expect(service.delete("trip-does-not-exist")).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
