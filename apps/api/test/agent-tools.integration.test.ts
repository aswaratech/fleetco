import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AgentToolRegistry } from "../src/modules/agent/tools/tool-registry";
import { type Actor, DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { CustomersService } from "../src/modules/customers/customers.service";
import { DriversService } from "../src/modules/drivers/drivers.service";
import { ExpenseLogsService } from "../src/modules/expense-logs/expense-logs.service";
import { FuelLogsService } from "../src/modules/fuel-logs/fuel-logs.service";
import { GeofencesService } from "../src/modules/geofences/geofences.service";
import { JobsService } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { ReportsService } from "../src/modules/reports/reports.service";
import { ServiceRecordsService } from "../src/modules/maintenance/service-records.service";
import { ServiceSchedulesService } from "../src/modules/maintenance/service-schedules.service";
import { TripsService } from "../src/modules/trips/trips.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { resetDb } from "./db";
import { seedFuelLog } from "./fixtures/agent";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// End-to-end registry dispatch against real Postgres (ADR-0043 c1/c6, ticket
// A4). Two load-bearing proofs live here:
//
//   1. THE NESTED-PII CASE: get_trip returns TripDetail with the FULL Driver
//      row nested inside — the redaction choke point must strip dateOfBirth
//      and mask licenseNumber one level down, while fullName/phone pass (c6).
//
//   2. ACTOR THREADING / DRIVER ROW-SCOPE INHERITANCE (c1): the registry
//      executes as the REAL requesting user, so a DRIVER actor sees only
//      their own trips/fuel logs through the same DriverScopeService
//      predicate the API enforces — inherited for free, not re-implemented —
//      and an unlinked DRIVER fails closed (403).

describe("agent tools end-to-end (real DB, ADR-0043 A4)", () => {
  let prisma: PrismaService;
  let registry: AgentToolRegistry;

  let adminId: string;
  let admin: Actor;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentToolRegistry,
        VehiclesService,
        DriversService,
        CustomersService,
        JobsService,
        TripsService,
        FuelLogsService,
        ExpenseLogsService,
        GeofencesService,
        ServiceSchedulesService,
        ServiceRecordsService,
        ReportsService,
        DriverScopeService,
        PrismaService,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    registry = moduleRef.get(AgentToolRegistry);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma, UserRole.ADMIN);
    admin = { userId: adminId, role: UserRole.ADMIN };
  });

  test("get_trip strips the nested driver's dateOfBirth and masks licenseNumber; fullName/phone pass", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId, {
      fullName: "Ram Bahadur Shrestha",
      phone: "+977-9800000000",
      licenseNumber: "12-345-6789",
      dateOfBirth: new Date("1990-01-01T00:00:00Z"),
    });
    const trip = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
    });

    const result = (await registry.execute("get_trip", { id: trip.id }, admin)) as {
      driver: Record<string, unknown>;
      vehicle: Record<string, unknown>;
    };

    expect("dateOfBirth" in result.driver).toBe(false);
    expect(result.driver.licenseNumber).toBe("***6789");
    expect(result.driver.fullName).toBe("Ram Bahadur Shrestha");
    expect(result.driver.phone).toBe("+977-9800000000");
    expect(result.vehicle.registrationNumber).toBe(vehicle.registrationNumber);
  });

  test("get_driver applies the same c6 contract on the top-level row", async () => {
    const driver = await seedDriver(prisma, adminId, {
      licenseNumber: "AB-9876-5432",
      dateOfBirth: new Date("1985-06-15T00:00:00Z"),
    });

    const result = (await registry.execute("get_driver", { id: driver.id }, admin)) as Record<
      string,
      unknown
    >;
    expect("dateOfBirth" in result).toBe(false);
    expect(result.licenseNumber).toBe("***5432");
    expect(result.fullName).toBe(driver.fullName);
  });

  test("list_drivers masks every row", async () => {
    await seedDriver(prisma, adminId, { licenseNumber: "XX-1111-0001" });
    await seedDriver(prisma, adminId, { licenseNumber: "XX-1111-0002" });

    const result = (await registry.execute("list_drivers", {}, admin)) as {
      items: { licenseNumber: string }[];
    };
    expect(result.items.map((d) => d.licenseNumber).sort()).toEqual(["***0001", "***0002"]);
  });

  test("DRIVER row-scope inheritance: a linked DRIVER sees only their own trips", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // The DRIVER login linked 1:1 to their Driver row (ADR-0034 c4).
    const driverUserId = await seedUser(prisma, UserRole.DRIVER);
    const ownDriver = await seedDriver(prisma, adminId, { userId: driverUserId });
    const otherDriver = await seedDriver(prisma, adminId);
    const ownTrip = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: ownDriver.id,
      createdById: adminId,
    });
    const foreignTrip = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: otherDriver.id,
      createdById: adminId,
    });
    const driverActor: Actor = { userId: driverUserId, role: UserRole.DRIVER };

    // The capability gate passes (DRIVER holds trips:*)…
    const listed = (await registry.execute("list_trips", {}, driverActor)) as {
      items: { id: string }[];
      total: number;
    };
    // …and the row scope narrows to the driver's own trips, exactly as the
    // HTTP surface does (the D2 predicate reached through the same service).
    expect(listed.total).toBe(1);
    expect(listed.items[0].id).toBe(ownTrip.id);

    // A foreign trip 404s (existence-hiding), not 403.
    await expect(
      registry.execute("get_trip", { id: foreignTrip.id }, driverActor),
    ).rejects.toBeInstanceOf(NotFoundException);

    // ADMIN sees both.
    const adminListed = (await registry.execute("list_trips", {}, admin)) as { total: number };
    expect(adminListed.total).toBe(2);
  });

  test("DRIVER row-scope inheritance: own fuel logs only; unlinked DRIVER fails closed (403)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const driverUserId = await seedUser(prisma, UserRole.DRIVER);
    await seedDriver(prisma, adminId, { userId: driverUserId });
    const driverActor: Actor = { userId: driverUserId, role: UserRole.DRIVER };

    // One fill keyed by the driver, one by the admin.
    await seedFuelLog(prisma, { vehicleId: vehicle.id, createdById: driverUserId });
    await seedFuelLog(prisma, { vehicleId: vehicle.id, createdById: adminId });

    const own = (await registry.execute("list_fuel_logs", {}, driverActor)) as { total: number };
    expect(own.total).toBe(1);

    const all = (await registry.execute("list_fuel_logs", {}, admin)) as { total: number };
    expect(all.total).toBe(2);

    // A DRIVER session with no linked Driver row is fail-closed at the
    // DriverScopeService seam (ADR-0034 c4) — inherited, not re-implemented.
    const unlinkedUserId = await seedUser(prisma, UserRole.DRIVER);
    const unlinked: Actor = { userId: unlinkedUserId, role: UserRole.DRIVER };
    await expect(registry.execute("list_trips", {}, unlinked)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("NotFound propagates from get tools for a missing id", async () => {
    await expect(
      registry.execute("get_vehicle", { id: "c00000000000000000000000" }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      registry.execute("get_job", { id: "c00000000000000000000000" }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test("list_geofences never returns boundary geometry (boundaryWkt stripped)", async () => {
    // Seed via raw Prisma to keep this test independent of the geofence
    // fixture's shape.
    await prisma.geofence.create({
      data: {
        name: "Kalimati depot",
        type: "DEPOT",
        boundaryWkt: "POLYGON((85.3 27.7, 85.31 27.7, 85.31 27.71, 85.3 27.7))",
        createdById: adminId,
      },
    });

    const result = (await registry.execute("list_geofences", {}, admin)) as {
      items: Record<string, unknown>[];
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("Kalimati depot");
    expect("boundaryWkt" in result.items[0]).toBe(false);
  });
});
