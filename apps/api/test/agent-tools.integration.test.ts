import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
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
import { seedCustomer, seedFuelLog, seedServiceSchedule } from "./fixtures/agent";
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

  // --- stage two: the create tools end-to-end (A7) --------------------------

  test("create_fuel_log derives totalCostPaisa server-side and the envelope carries the entity (c1/c4c)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);

    // The FuelLogsService docblock's worked example: 12345 mL × 11055
    // paisa/L = 136473.975 → half-up 136474 — the derivation the wrapper
    // structurally cannot override.
    const outcome = await registry.dispatch(
      "create_fuel_log",
      {
        vehicleId: vehicle.id,
        date: "2026-07-01",
        litersMl: 12_345,
        pricePerLiterPaisa: 11_055,
      },
      admin,
    );

    const result = outcome.result as { id: string; totalCostPaisa: number };
    expect(result.totalCostPaisa).toBe(136_474);
    expect(outcome.entity).toEqual({ type: "FuelLog", id: result.id });

    // c1 for writes: createdById is the requesting HUMAN, never a synthetic
    // actor and never a body field.
    const row = await prisma.fuelLog.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.createdById).toBe(adminId);
  });

  test("create_job generates the JOB-YYYY-NNNNN number server-side", async () => {
    const customer = await seedCustomer(prisma, adminId);

    const outcome = await registry.dispatch(
      "create_job",
      { customerId: customer.id, description: "Haul aggregate Kalimati -> site" },
      admin,
    );

    const result = outcome.result as { id: string; jobNumber: string; customer: { id: string } };
    expect(result.jobNumber).toMatch(/^JOB-\d{4}-\d{5}$/);
    expect(result.customer.id).toBe(customer.id);
    expect(outcome.entity).toEqual({ type: "Job", id: result.id });
  });

  test("create_vehicle: duplicate registrationNumber → ConflictException (P2002 → 409 passthrough)", async () => {
    const args = {
      registrationNumber: "BA 2 KHA 5555",
      kind: "TIPPER",
      make: "Tata",
      model: "LPK 2518",
      year: 2024,
      acquiredAt: "2026-01-15",
    };
    const first = await registry.dispatch("create_vehicle", args, admin);
    expect(first.entity?.type).toBe("Vehicle");

    await expect(registry.dispatch("create_vehicle", args, admin)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  test("create_trip as a DRIVER actor → ForbiddenException (the service-level role rule, pinned)", async () => {
    // The coarse capability filter LISTS create_trip for DRIVER (trips:*),
    // but TripsService.create rejects DRIVER actors — the loop records this
    // as a `denied` action. Moot while agent:use is ADMIN-only; pinned so
    // the behavior is deliberate, not accidental.
    const vehicle = await seedVehicle(prisma, adminId);
    const driverUserId = await seedUser(prisma, UserRole.DRIVER);
    const ownDriver = await seedDriver(prisma, adminId, { userId: driverUserId });
    const driverActor: Actor = { userId: driverUserId, role: UserRole.DRIVER };

    await expect(
      registry.dispatch(
        "create_trip",
        { vehicleId: vehicle.id, driverId: ownDriver.id, status: "PLANNED" },
        driverActor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  test("DRIVER create_fuel_log: own-trip pairing enforced; foreign trip 404s (failed, not denied)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
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
    const baseArgs = {
      vehicleId: vehicle.id,
      date: "2026-07-01",
      litersMl: 40_000,
      pricePerLiterPaisa: 16_500,
    };

    // No trip → the service's DRIVER must-pair rule rejects (400-shaped).
    await expect(
      registry.dispatch("create_fuel_log", baseArgs, driverActor),
    ).rejects.toBeInstanceOf(BadRequestException);

    // A foreign trip 404s (existence-hiding — a failed execution).
    await expect(
      registry.dispatch("create_fuel_log", { ...baseArgs, tripId: foreignTrip.id }, driverActor),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Their OWN trip on the same vehicle succeeds — the D2 row-scope
    // inherited on a WRITE path, for free.
    const outcome = await registry.dispatch(
      "create_fuel_log",
      { ...baseArgs, tripId: ownTrip.id },
      driverActor,
    );
    expect(outcome.entity?.type).toBe("FuelLog");
  });

  test("create_driver: the redacted RESULT masks/strips PII while the DB row stores it (c6)", async () => {
    const outcome = await registry.dispatch(
      "create_driver",
      {
        fullName: "Sita Kumari Thapa",
        licenseNumber: "03-066-041999",
        licenseClass: "HMV",
        phone: "+977-9812345678",
        dateOfBirth: "1990-04-12",
        hiredAt: "2026-07-01",
        licenseExpiresAt: "2028-04-11",
      },
      admin,
    );

    const result = outcome.result as Record<string, unknown>;
    expect("dateOfBirth" in result).toBe(false);
    expect(result.licenseNumber).toBe("***1999");

    const row = await prisma.driver.findUniqueOrThrow({
      where: { id: (outcome.entity as { id: string }).id },
    });
    expect(row.licenseNumber).toBe("03-066-041999");
    expect(row.dateOfBirth?.toISOString().slice(0, 10)).toBe("1990-04-12");
  });

  test("create_expense_log: vehicle-agnostic (no vehicleId) is a first-class row", async () => {
    const outcome = await registry.dispatch(
      "create_expense_log",
      { date: "2026-07-01", category: "INSURANCE", amountPaisa: 4_500_000 },
      admin,
    );
    const result = outcome.result as { id: string; vehicleId: string | null };
    expect(result.vehicleId).toBeNull();
    expect(outcome.entity).toEqual({ type: "ExpenseLog", id: result.id });
  });

  test("create_service_record against a schedule advances its anchor (the in-service transaction)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const schedule = await seedServiceSchedule(prisma, {
      vehicleId: vehicle.id,
      createdById: adminId,
      lastServiceOdometerKm: 75_000,
    });

    const outcome = await registry.dispatch(
      "create_service_record",
      {
        vehicleId: vehicle.id,
        serviceScheduleId: schedule.id,
        performedAt: "2026-07-01",
        odometerKm: 80_000,
      },
      admin,
    );
    expect(outcome.entity?.type).toBe("ServiceRecord");

    const advanced = await prisma.serviceSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    expect(advanced.lastServiceOdometerKm).toBe(80_000);
  });
});
