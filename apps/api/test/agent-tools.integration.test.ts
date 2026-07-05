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
import { seedCustomer, seedFuelLog, seedJob, seedServiceSchedule } from "./fixtures/agent";
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

  // --- stage two: the update tools + pre-image (A8) -------------------------

  test("update_vehicle: the envelope carries the entity + the RAW pre-image; the field changes", async () => {
    const vehicle = await seedVehicle(prisma, adminId, {
      registrationNumber: "BA 9 KHA 0001",
      odometerCurrentKm: 12_000,
    });

    const outcome = await registry.dispatch(
      "update_vehicle",
      { id: vehicle.id, odometerCurrentKm: 12_500 },
      admin,
    );

    expect(outcome.entity).toEqual({ type: "Vehicle", id: vehicle.id });
    // The pre-image is the PRIOR row (odometer 12000), raw — dates as ISO
    // strings from the JSON round-trip, never redacted.
    const pre = outcome.preImage as { id: string; odometerCurrentKm: number };
    expect(pre.id).toBe(vehicle.id);
    expect(pre.odometerCurrentKm).toBe(12_000);
    // The stored row now carries the new value.
    const after = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(after.odometerCurrentKm).toBe(12_500);
  });

  test("update_vehicle: status → RETIRED auto-stamps retiredAt (the service transition)", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { status: "ACTIVE" });
    const outcome = await registry.dispatch(
      "update_vehicle",
      { id: vehicle.id, status: "RETIRED" },
      admin,
    );
    const result = outcome.result as { status: string; retiredAt: string | null };
    expect(result.status).toBe("RETIRED");
    expect(result.retiredAt).not.toBeNull();
  });

  test("update_driver: the pre-image keeps PII raw while the redacted RESULT masks/strips it (c6)", async () => {
    const driver = await seedDriver(prisma, adminId, {
      fullName: "Old Name",
      licenseNumber: "07-100-200300",
      dateOfBirth: new Date("1988-03-03T00:00:00Z"),
    });

    const outcome = await registry.dispatch(
      "update_driver",
      { id: driver.id, fullName: "New Name" },
      admin,
    );

    // The result crosses to the model: masked/stripped.
    const result = outcome.result as Record<string, unknown>;
    expect(result.fullName).toBe("New Name");
    expect("dateOfBirth" in result).toBe(false);
    expect(result.licenseNumber).toBe("***0300");
    // The pre-image is the undo source: faithful, unredacted. At the dispatch
    // envelope it is the RAW Prisma row (Date objects); the JSON round-trip to
    // ISO strings happens only when the loop persists it to previousJson
    // (asserted in agent-loop.test.ts).
    const pre = outcome.preImage as { fullName: string; licenseNumber: string; dateOfBirth: Date };
    expect(pre.fullName).toBe("Old Name");
    expect(pre.licenseNumber).toBe("07-100-200300");
    expect(pre.dateOfBirth.toISOString()).toBe("1988-03-03T00:00:00.000Z");
  });

  test("update_trip: IN_PROGRESS → COMPLETED bumps the vehicle meter in the same transaction", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { odometerCurrentKm: 50_000 });
    const trip = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: (await seedDriver(prisma, adminId)).id,
      createdById: adminId,
      status: "IN_PROGRESS",
      startedAt: new Date("2026-07-01T06:00:00Z"),
      startOdometerKm: 50_000,
    });

    // Completing a km-metered trip requires both timestamps and the end
    // odometer (the service's meter-aware cross-field rule on the merged
    // shape).
    const outcome = await registry.dispatch(
      "update_trip",
      {
        id: trip.id,
        status: "COMPLETED",
        endedAt: "2026-07-01T14:00:00Z",
        endOdometerKm: 50_420,
      },
      admin,
    );
    expect(outcome.entity).toEqual({ type: "Trip", id: trip.id });
    // The pre-image caught the IN_PROGRESS row.
    expect((outcome.preImage as { status: string }).status).toBe("IN_PROGRESS");
    // The vehicle's odometer advanced to the trip's end reading.
    const after = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(after.odometerCurrentKm).toBe(50_420);
  });

  test("update_trip: an illegal status transition → BadRequest (the service transition matrix)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const trip = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: (await seedDriver(prisma, adminId)).id,
      createdById: adminId,
      status: "COMPLETED",
    });
    // COMPLETED is terminal — no reverse transition.
    await expect(
      registry.dispatch("update_trip", { id: trip.id, status: "IN_PROGRESS" }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("update_vehicle on a missing id → NotFound (nothing to capture, nothing changed)", async () => {
    await expect(
      registry.dispatch("update_vehicle", { id: "c00000000000000000000000", make: "X" }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test("update_vehicle: a duplicate registrationNumber → ConflictException (P2002 → 409)", async () => {
    await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 PA 1111" });
    const other = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 PA 2222" });
    await expect(
      registry.dispatch(
        "update_vehicle",
        { id: other.id, registrationNumber: "BA 1 PA 1111" },
        admin,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // --- registry completion: the five P2 update tools (ADR-0044) -------------

  test("update_customer: INACTIVE + null clears email; the pre-image keeps the prior row", async () => {
    const customer = await seedCustomer(prisma, adminId, { email: "old@acme.example" });
    const outcome = await registry.dispatch(
      "update_customer",
      { id: customer.id, status: "INACTIVE", email: null },
      admin,
    );
    expect(outcome.entity).toEqual({ type: "Customer", id: customer.id });
    const pre = outcome.preImage as { status: string; email: string | null };
    expect(pre.status).toBe("ACTIVE");
    expect(pre.email).toBe("old@acme.example");
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.status).toBe("INACTIVE");
    expect(after.email).toBeNull();
  });

  test("update_customer: a duplicate panNumber → ConflictException (normalized uppercase, P2002 → 409)", async () => {
    await seedCustomer(prisma, adminId, { panNumber: "PAN111111" });
    const other = await seedCustomer(prisma, adminId, { panNumber: "PAN222222" });
    // Lowercase on the wire — the service's trim+uppercase normalization runs
    // before the uniqueness check, exactly as on the PATCH endpoint.
    await expect(
      registry.dispatch("update_customer", { id: other.id, panNumber: "pan111111" }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  test("update_job: the pre-image is the RAW row (no nested customer); the merged date rule fires", async () => {
    const customer = await seedCustomer(prisma, adminId);
    const job = await seedJob(prisma, {
      customerId: customer.id,
      createdById: adminId,
      scheduledStartDate: new Date("2026-07-01T00:00:00Z"),
      scheduledEndDate: new Date("2026-07-05T00:00:00Z"),
    });

    const outcome = await registry.dispatch(
      "update_job",
      { id: job.id, description: "Regraded haul road — extended scope" },
      admin,
    );
    expect(outcome.entity).toEqual({ type: "Job", id: job.id });
    const pre = outcome.preImage as Record<string, unknown>;
    expect(pre.id).toBe(job.id);
    expect("customer" in pre).toBe(false); // findByIdRaw — the faithful undo source

    // Moving the start past the STORED end violates end-≥-start on the merged
    // row (the service's defense-in-depth re-check for one-sided patches).
    await expect(
      registry.dispatch("update_job", { id: job.id, scheduledStartDate: "2026-07-10" }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("update_fuel_log: totalCostPaisa recomputes when litersMl changes; the pre-image keeps the old total", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const log = await seedFuelLog(prisma, {
      vehicleId: vehicle.id,
      createdById: adminId,
      litersMl: 45_000,
      pricePerLiterPaisa: 16_500,
      totalCostPaisa: 742_500,
    });
    const outcome = await registry.dispatch(
      "update_fuel_log",
      { id: log.id, litersMl: 50_000 },
      admin,
    );
    expect((outcome.preImage as { totalCostPaisa: number }).totalCostPaisa).toBe(742_500);
    const after = await prisma.fuelLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(after.litersMl).toBe(50_000);
    expect(after.totalCostPaisa).toBe(825_000); // 50 000 mL × 16 500 paisa/L ÷ 1000
  });

  test("update_fuel_log: a DRIVER updating a foreign fill → NotFound (the own-record 404, ADR-0034 c4)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const log = await seedFuelLog(prisma, { vehicleId: vehicle.id, createdById: adminId });
    const driverUserId = await seedUser(prisma, UserRole.DRIVER);
    const driverActor: Actor = { userId: driverUserId, role: UserRole.DRIVER };
    await expect(
      registry.dispatch("update_fuel_log", { id: log.id, station: "Sajha Petrol" }, driverActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test("update_expense_log: the amount changes and the pre-image keeps the prior row", async () => {
    const created = (await registry.execute(
      "create_expense_log",
      { date: "2026-07-01", category: "INSURANCE", amountPaisa: 1_500_000 },
      admin,
    )) as { id: string };
    const outcome = await registry.dispatch(
      "update_expense_log",
      { id: created.id, amountPaisa: 1_750_000, vendor: "Shikhar Insurance" },
      admin,
    );
    expect(outcome.entity).toEqual({ type: "ExpenseLog", id: created.id });
    expect((outcome.preImage as { amountPaisa: number }).amountPaisa).toBe(1_500_000);
    const after = await prisma.expenseLog.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.amountPaisa).toBe(1_750_000);
    expect(after.vendor).toBe("Shikhar Insurance");
  });

  test("update_service_record: a PATCH does NOT advance the linked schedule's anchor", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const schedule = await seedServiceSchedule(prisma, {
      vehicleId: vehicle.id,
      createdById: adminId,
      lastServiceOdometerKm: 75_000,
    });
    const created = (await registry.execute(
      "create_service_record",
      {
        vehicleId: vehicle.id,
        serviceScheduleId: schedule.id,
        performedAt: "2026-07-01",
        odometerKm: 80_000,
      },
      admin,
    )) as { id: string };

    // create advanced the anchor to 80 000 (the A7 behavior, pinned above);
    // the P2 PATCH corrects the record without moving the anchor again.
    const outcome = await registry.dispatch(
      "update_service_record",
      { id: created.id, odometerKm: 81_000 },
      admin,
    );
    expect((outcome.preImage as { odometerKm: number | null }).odometerKm).toBe(80_000);
    const after = await prisma.serviceRecord.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.odometerKm).toBe(81_000);
    const anchor = await prisma.serviceSchedule.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(anchor.lastServiceOdometerKm).toBe(80_000); // unchanged by the edit
  });
});
