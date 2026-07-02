import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole, VehicleStatus } from "@prisma/client";
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
import { seedUser, seedVehicle } from "./fixtures/trip";

// Validation-layer tests for the agent tools (ADR-0043 c2, ticket A4): the
// wrapper schemas reject malformed model output with the house 400 shape
// (the reused ZodValidationPipe's "field: message" convention), and the
// wrapper → toQueryShape → module-schema round-trip delivers REAL typed
// filters to the service (proven against seeded rows).

const ADMIN: Actor = { userId: "user_admin", role: UserRole.ADMIN };

describe("agent tool validation (ADR-0043 A4)", () => {
  let prisma: PrismaService;
  let registry: AgentToolRegistry;

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
  });

  test("unknown args keys are rejected 400-shaped with the field named (.strict())", async () => {
    const error = await registry
      .execute("list_vehicles", { bogusKey: true }, ADMIN)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toContain("bogusKey");
  });

  test("a bad enum member in a filter array is rejected", async () => {
    await expect(
      registry.execute("list_vehicles", { status: ["ACTIVE", "FLYING"] }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("take above the 200 ceiling and non-integer skip are rejected", async () => {
    await expect(registry.execute("list_vehicles", { take: 201 }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(registry.execute("list_vehicles", { skip: 1.5 }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test("a non-ISO date string on a report is rejected by the wrapper", async () => {
    await expect(
      registry.execute("report_per_vehicle_cost", { from: "01/06/2026", to: "2026-06-30" }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("reports inherit the module schema's from ≤ to cross-field refine (c2 re-validation)", async () => {
    const error = await registry
      .execute("report_per_vehicle_cost", { from: "2026-06-30", to: "2026-06-01" }, ADMIN)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BadRequestException);
  });

  test("get tools reject a missing/empty id", async () => {
    await expect(registry.execute("get_vehicle", {}, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(registry.execute("get_vehicle", { id: "   " }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  test("round-trip proof: a typed enum-array filter reaches the service as a real Prisma filter", async () => {
    const adminId = await seedUser(prisma);
    await seedVehicle(prisma, adminId, { status: VehicleStatus.ACTIVE });
    await seedVehicle(prisma, adminId, { status: VehicleStatus.IN_MAINTENANCE });
    await seedVehicle(prisma, adminId, { status: VehicleStatus.RETIRED });

    const result = (await registry.execute(
      "list_vehicles",
      { status: ["ACTIVE", "IN_MAINTENANCE"], sortBy: "registrationNumber", sortDir: "asc" },
      ADMIN,
    )) as { items: { status: string }[]; total: number };

    expect(result.total).toBe(2);
    expect(result.items.map((v) => v.status).sort()).toEqual(["ACTIVE", "IN_MAINTENANCE"]);
  });

  test("pagination round-trips: take/skip as real numbers", async () => {
    const adminId = await seedUser(prisma);
    for (let i = 0; i < 3; i += 1) {
      await seedVehicle(prisma, adminId);
    }
    const page = (await registry.execute(
      "list_vehicles",
      { take: 2, skip: 2, sortBy: "createdAt", sortDir: "asc" },
      ADMIN,
    )) as { items: unknown[]; total: number };
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
  });
});
