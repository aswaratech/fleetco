import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AgentToolRegistry } from "../src/modules/agent/tools/tool-registry";
import { MAX_TOOL_COUNT, TOOL_NAME_PATTERN } from "../src/modules/agent/tools/tool.types";
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

// Registry-level tests for the agent tool registry (ADR-0043 c1–c3, tickets
// A4/A7): the boot-time guarantees (every wrapper converts to JSON Schema —
// c2's drift-becomes-loud-errors promise; name↔tier coherence; every write
// declares its entity type), the dispatch pipeline's authorization
// (capability before validation, mirroring guard-before-pipe), and the
// role-filtered tool listing the A5 loop hands to the model.
//
// The registry is built from the REAL services via the providers-direct
// pattern (the trips.service.test.ts precedent — no AuthModule/HTTP): the
// capability checks here never reach the database, so no seeding is needed;
// the DB-touching paths live in agent-tools.integration.test.ts.

const ADMIN: Actor = { userId: "user_admin", role: UserRole.ADMIN };
const OFFICE: Actor = { userId: "user_office", role: UserRole.OFFICE_STAFF };
const DRIVER: Actor = { userId: "user_driver", role: UserRole.DRIVER };

// The full curated surface (c3): 22 domain read tools + fleet_snapshot (A4)
// + the 8 stage-two creates (A7). A new tool is added HERE and in its
// builder in the same commit — deliberate friction against silent growth.
const EXPECTED_TOOLS = [
  "list_vehicles",
  "get_vehicle",
  "create_vehicle",
  "list_drivers",
  "get_driver",
  "create_driver",
  "list_customers",
  "get_customer",
  "create_customer",
  "list_jobs",
  "get_job",
  "create_job",
  "list_trips",
  "get_trip",
  "create_trip",
  "list_fuel_logs",
  "get_fuel_log",
  "create_fuel_log",
  "list_expense_logs",
  "get_expense_log",
  "create_expense_log",
  "list_geofences",
  "get_geofence",
  "list_service_schedules",
  "get_service_schedule",
  "list_service_records",
  "get_service_record",
  "create_service_record",
  "report_per_vehicle_cost",
  "report_per_vehicle_efficiency",
  "fleet_snapshot",
];

describe("AgentToolRegistry (ADR-0043 A4)", () => {
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
    // Most tests here never touch the DB, but the two that execute reads
    // must not see rows a sibling test file left behind.
    await resetDb(prisma);
  });

  test("registers exactly the curated surface — and NOTHING invoice/GPS/user/delete shaped (c3)", () => {
    expect(registry.listToolNames().sort()).toEqual([...EXPECTED_TOOLS].sort());
    // The structural absences, asserted by name-shape: no invoice tools, no
    // raw-GPS/telematics tools, no user/role tools, and NO DELETES — the c3
    // exclusions that stay absent forever (creates/updates are stage two,
    // no longer excluded).
    for (const name of registry.listToolNames()) {
      expect(name).not.toMatch(/invoice|gps|ping|telematic|user|role|delete/);
    }
  });

  test("boot generated a JSON schema for EVERY tool: type object, additionalProperties false", () => {
    // z.toJSONSchema ran in the constructor without throwing (a wrapper that
    // drifted into .transform()/z.coerce would have failed the boot). Assert
    // the emitted schemas are the strict-object shape DeepSeek expects.
    const specs = registry.listToolDefinitions(UserRole.ADMIN);
    expect(specs).toHaveLength(EXPECTED_TOOLS.length);
    for (const spec of specs) {
      expect(spec.type).toBe("function");
      expect(spec.function.description.length).toBeGreaterThan(0);
      expect(spec.function.parameters.type).toBe("object");
      expect(spec.function.parameters.additionalProperties).toBe(false);
    }
  });

  test("every tool name satisfies the provider constraint and the count fits the ceiling", () => {
    const names = registry.listToolNames();
    expect(names.length).toBeLessThanOrEqual(MAX_TOOL_COUNT);
    for (const name of names) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
    }
  });

  test("listToolDefinitions filters by role (capability-exact; the create_trip caveat pinned)", () => {
    const adminTools = registry.listToolDefinitions(UserRole.ADMIN).map((s) => s.function.name);
    const officeTools = registry
      .listToolDefinitions(UserRole.OFFICE_STAFF)
      .map((s) => s.function.name);
    const driverTools = registry.listToolDefinitions(UserRole.DRIVER).map((s) => s.function.name);

    // ADMIN and OFFICE_STAFF both hold the full operational floor every
    // registered tool requires (agent:use — who may CHAT — is the route
    // gate, not a tool capability).
    expect(adminTools.sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(officeTools.sort()).toEqual([...EXPECTED_TOOLS].sort());
    // DRIVER holds exactly trips:* + fuel-logs:* — six tools now, and
    // emphatically not fleet_snapshot (its multi-token AND requires the
    // whole floor). create_trip IS listed (the capability filter is coarse
    // by design, ADR-0028) even though TripsService.create rejects DRIVER
    // actors at the service layer — the loop records that as `denied`; moot
    // while agent:use is ADMIN-only. create_fuel_log genuinely works for a
    // DRIVER (own-trip pairing enforced in the service).
    expect(driverTools.sort()).toEqual(
      [
        "list_trips",
        "get_trip",
        "create_trip",
        "list_fuel_logs",
        "get_fuel_log",
        "create_fuel_log",
      ].sort(),
    );
  });

  test("an unknown tool name is NotFound", async () => {
    await expect(registry.execute("drop_all_tables", {}, ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test("capability enforcement: DRIVER is Forbidden on list_vehicles (403-shaped)", async () => {
    await expect(registry.execute("list_vehicles", {}, DRIVER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("capability enforcement: fleet_snapshot's multi-token AND rejects DRIVER", async () => {
    await expect(registry.execute("fleet_snapshot", {}, DRIVER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  test("OFFICE_STAFF passes the geofences:read gate (list_geofences executes)", async () => {
    // geofences:read is on the operational floor; empty table → empty list.
    const result = (await registry.execute("list_geofences", {}, OFFICE)) as { items: unknown[] };
    expect(result.items).toEqual([]);
  });

  test("authorization runs BEFORE validation: wrong role + bogus args → 403, not 400", async () => {
    await expect(
      registry.execute("list_vehicles", { bogusKey: true, take: -5 }, DRIVER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  test("name ↔ tier coherence: create_* are reversible-write with an entity type; the rest read", () => {
    for (const name of registry.listToolNames()) {
      const tool = registry.getTool(name);
      if (/^(create|update)_/.test(name)) {
        expect(tool?.riskTier).toBe("reversible-write");
        // Every write must declare its affected entity type — the audit
        // row's deep-link derives from it (c4c); also boot-asserted.
        expect(typeof tool?.resultEntityType).toBe("string");
      } else {
        expect(tool?.riskTier).toBe("read");
        expect(tool?.resultEntityType).toBeUndefined();
      }
    }
  });
});
