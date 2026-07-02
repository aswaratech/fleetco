import { Test } from "@nestjs/testing";
import { TripStatus, UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { currentMonthRange, tallyCompliance } from "../src/modules/agent/tools/fleet-snapshot.tool";
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
import { seedExpenseLog } from "./fixtures/expense-log";
import { seedFuelLog, seedServiceSchedule } from "./fixtures/agent";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// fleet_snapshot tests (ADR-0043 c3, ticket A4): the pure helpers
// (currentMonthRange, tallyCompliance) and the seeded seven-read composition,
// including that the snapshot output passes the redaction contract.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("fleet_snapshot pure helpers", () => {
  test("currentMonthRange is first-of-month → today, UTC", () => {
    expect(currentMonthRange(new Date("2026-07-02T10:30:00Z"))).toEqual({
      from: "2026-07-01",
      to: "2026-07-02",
    });
    // First of the month: from === to.
    expect(currentMonthRange(new Date("2026-07-01T00:00:00Z"))).toEqual({
      from: "2026-07-01",
      to: "2026-07-01",
    });
  });

  test("tallyCompliance buckets by the WORST of the three documents", () => {
    const now = new Date("2026-07-02T00:00:00Z");
    const days = (n: number): Date => new Date(now.getTime() + n * MS_PER_DAY);
    const tally = tallyCompliance(
      [
        // Expired insurance beats a clean bluebook → expired bucket.
        { bluebookExpiresAt: days(300), insuranceExpiresAt: days(-1), routePermitExpiresAt: null },
        // Expiring-soon route permit → expiring-soon bucket.
        { bluebookExpiresAt: days(300), insuranceExpiresAt: null, routePermitExpiresAt: days(10) },
        // All clean / absent → neither bucket.
        { bluebookExpiresAt: days(300), insuranceExpiresAt: days(200), routePermitExpiresAt: null },
        { bluebookExpiresAt: null, insuranceExpiresAt: null, routePermitExpiresAt: null },
      ],
      now,
    );
    expect(tally).toEqual({ expiredCount: 1, expiringSoonCount: 1, total: 4 });
  });
});

describe("fleet_snapshot composition (real DB)", () => {
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

  test("composes counts, active trips, month costs, recents, compliance, and maintenance", async () => {
    const now = new Date();
    const past = (days: number): Date => new Date(now.getTime() - days * MS_PER_DAY);
    const soon = (days: number): Date => new Date(now.getTime() + days * MS_PER_DAY);

    // Vehicles: one clean, one with an expired bluebook, one expiring soon.
    const clean = await seedVehicle(prisma, adminId, { bluebookExpiresAt: soon(300) });
    const expired = await seedVehicle(prisma, adminId, { bluebookExpiresAt: past(2) });
    await seedVehicle(prisma, adminId, { insuranceExpiresAt: soon(10) });

    const driver = await seedDriver(prisma, adminId);

    // Trips: two IN_PROGRESS, one COMPLETED (only in-progress count/land).
    await seedTrip(prisma, {
      vehicleId: clean.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.IN_PROGRESS,
      startedAt: past(1),
      startOdometerKm: 1000,
    });
    await seedTrip(prisma, {
      vehicleId: expired.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.IN_PROGRESS,
      startedAt: past(2),
      startOdometerKm: 500,
    });
    await seedTrip(prisma, {
      vehicleId: clean.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.COMPLETED,
      startedAt: past(10),
      endedAt: past(9),
      startOdometerKm: 100,
      endOdometerKm: 200,
    });

    // Money: one fuel fill and one expense INSIDE the current month window
    // (today), one expense outside it (45 days ago — a prior month for sure).
    await seedFuelLog(prisma, {
      vehicleId: clean.id,
      createdById: adminId,
      date: now,
      totalCostPaisa: 500_000,
    });
    await seedExpenseLog(prisma, {
      vehicleId: clean.id,
      createdById: adminId,
      date: now,
      amountPaisa: 250_000,
    });
    await seedExpenseLog(prisma, {
      vehicleId: clean.id,
      createdById: adminId,
      date: past(45),
      amountPaisa: 999_999,
    });

    // Maintenance: one ACTIVE, one INACTIVE schedule.
    await seedServiceSchedule(prisma, { vehicleId: clean.id, createdById: adminId });
    await seedServiceSchedule(prisma, {
      vehicleId: clean.id,
      createdById: adminId,
      status: "INACTIVE",
    });

    const snapshot = (await registry.execute("fleet_snapshot", {}, admin)) as {
      counts: { vehicles: number; drivers: number; activeTrips: number };
      compliance: { expiredCount: number; expiringSoonCount: number; total: number };
      activeTrips: { items: unknown[]; total: number };
      thisMonthCost: {
        from: string;
        to: string;
        totals: { fuelPaisa: number; expensePaisa: number; totalPaisa: number };
      };
      recentFuel: unknown[];
      recentExpenses: unknown[];
      maintenance: { activeScheduleCount: number };
    };

    expect(snapshot.counts).toEqual({ vehicles: 3, drivers: 1, activeTrips: 2 });
    expect(snapshot.compliance).toEqual({ expiredCount: 1, expiringSoonCount: 1, total: 3 });
    expect(snapshot.activeTrips.total).toBe(2);
    expect(snapshot.activeTrips.items).toHaveLength(2);
    // The month window covers today's fuel + expense, not the 45-day-old one.
    expect(snapshot.thisMonthCost.totals.fuelPaisa).toBe(500_000);
    expect(snapshot.thisMonthCost.totals.expensePaisa).toBe(250_000);
    expect(snapshot.thisMonthCost.totals.totalPaisa).toBe(750_000);
    expect(snapshot.recentFuel).toHaveLength(1);
    // Recent expenses list is unwindowed (most recent 5 by date).
    expect(snapshot.recentExpenses).toHaveLength(2);
    expect(snapshot.maintenance.activeScheduleCount).toBe(1);
  });

  test("the snapshot's output passes the redaction contract (JSON-safe, no stripped keys)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId, {
      dateOfBirth: new Date("1990-01-01T00:00:00Z"),
    });
    await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.IN_PROGRESS,
      startedAt: new Date(),
      startOdometerKm: 10,
    });

    const snapshot = await registry.execute("fleet_snapshot", {}, admin);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("dateOfBirth");
    expect(serialized).not.toContain("boundaryWkt");
    expect(serialized).not.toContain("1990-01-01");
  });

  test("an empty fleet snapshots to zeros, not errors", async () => {
    const snapshot = (await registry.execute("fleet_snapshot", {}, admin)) as {
      counts: { vehicles: number; drivers: number; activeTrips: number };
      compliance: { total: number };
      maintenance: { activeScheduleCount: number };
    };
    expect(snapshot.counts).toEqual({ vehicles: 0, drivers: 0, activeTrips: 0 });
    expect(snapshot.compliance.total).toBe(0);
    expect(snapshot.maintenance.activeScheduleCount).toBe(0);
  });
});
