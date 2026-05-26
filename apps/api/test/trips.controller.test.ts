import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TripStatus, type Vehicle, type Driver } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsController } from "../src/modules/trips/trips.controller";
import { TripsService } from "../src/modules/trips/trips.service";
import { ListTripsQuerySchema } from "../src/modules/trips/trips.schemas";
import { resetDb } from "./db";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// Integration tests for TripsController, mirroring drivers.controller.test.ts
// in shape. Two layers:
//
//   1. Schema/pipe layer — ZodValidationPipe over ListTripsQuerySchema
//      tested directly without booting Nest. The iter-8 kickoff calls
//      for: bogus key → 400; invalid enum → 400; off-whitelist sortBy
//      → 400; take > 200 → 400; vehicleId is accepted as any string
//      (the "service no-ops on unknown id" branch).
//
//   2. Controller layer — TripsController.list() and .getById() against
//      a real PrismaService + TripsService, with AuthGuard overridden
//      via `overrideGuard(AuthGuard).useValue({ canActivate: () => true })`
//      so the test does not need a real better-auth session. The
//      response shape { items, total, skip, take, sortBy, sortDir } is
//      asserted here.

describe("TripsController list-query schema (iter-8 contract)", () => {
  const pipe = new ZodValidationPipe(ListTripsQuerySchema);

  test("bogus query key (e.g. ?statuss=PLANNED) → BadRequestException (HTTP 400)", () => {
    // The schema is `.strict()`, so an unknown key fails parse(). The
    // pipe translates ZodError to BadRequestException. The runbook's
    // api-error-mapping table is the spec being verified here.
    expect(() => pipe.transform({ statuss: "PLANNED" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    expect(() => pipe.transform({ status: "NONSENSE" })).toThrow(BadRequestException);
  });

  test("invalid sortBy column (off-whitelist) → BadRequestException", () => {
    // The whitelist is startedAt / endedAt / createdAt. Anything else
    // — including legitimate-looking `notes` or `vehicleId` — returns
    // 400. The defense covers both expensive sorts and accidental
    // information disclosure (`sortBy=notes` would expose ordering
    // information about free-form operator text).
    expect(() => pipe.transform({ sortBy: "notes" })).toThrow(BadRequestException);
  });

  test("sortBy=vehicleId is rejected (off-whitelist defense)", () => {
    // Even a legitimately-existing column that is NOT in the whitelist
    // is rejected. Pinned so a refactor that "helpfully" widens the
    // whitelist to all columns would fail loudly.
    expect(() => pipe.transform({ sortBy: "vehicleId" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException with field-named message", () => {
    try {
      pipe.transform({ take: "999" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message;
      expect(message.toLowerCase()).toContain("take");
    }
  });

  test("skip below zero → BadRequestException", () => {
    expect(() => pipe.transform({ skip: "-1" })).toThrow(BadRequestException);
  });

  test("non-integer take → BadRequestException", () => {
    expect(() => pipe.transform({ take: "abc" })).toThrow(BadRequestException);
  });

  test("vehicleId filter: any non-empty string is accepted (kickoff explicit no-op-on-unknown-id contract)", () => {
    // The kickoff explicitly allows "accept any string and let the
    // service no-op": a non-cuid string like "abc" should pass the
    // schema, then naturally produce an empty result at the service
    // layer (asserted in trips.service.test.ts). Pinned here so a
    // future tightening to a strict cuid format would surface as an
    // obvious behavior change requiring an ADR.
    const result = pipe.transform({ vehicleId: "abc-not-a-cuid" });
    expect(result.vehicleId).toBe("abc-not-a-cuid");
  });

  test("driverId filter behaves the same as vehicleId (accepts any non-empty string)", () => {
    const result = pipe.transform({ driverId: "no-such-driver" });
    expect(result.driverId).toBe("no-such-driver");
  });

  test("empty vehicleId (?vehicleId=) is normalized to undefined (treated as 'no filter')", () => {
    // Empty string after trim is meaningless as a filter — the schema
    // maps it to undefined so the service omits the filter rather
    // than asking Prisma for `where vehicleId = ''`.
    const result = pipe.transform({ vehicleId: "" });
    expect(result.vehicleId).toBeUndefined();
  });

  test("valid query passes through with parsed types (string → number, csv → array)", () => {
    const result = pipe.transform({
      status: "PLANNED,IN_PROGRESS",
      vehicleId: "vh_abc",
      driverId: "dr_xyz",
      sortBy: "startedAt",
      sortDir: "desc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual([TripStatus.PLANNED, TripStatus.IN_PROGRESS]);
    expect(result.vehicleId).toBe("vh_abc");
    expect(result.driverId).toBe("dr_xyz");
    expect(result.sortBy).toBe("startedAt");
    expect(result.sortDir).toBe("desc");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → undefined fields (defaults applied at controller/service)", () => {
    const result = pipe.transform({});
    expect(result.status).toBeUndefined();
    expect(result.vehicleId).toBeUndefined();
    expect(result.driverId).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });
});

describe("TripsController.list / getById (integration, real Prisma)", () => {
  // Full controller-level integration: a real TripsController with a
  // real TripsService and a real PrismaService, with AuthGuard
  // overridden to pass-through. The kickoff calls for the response
  // shape { items, total, skip, take, sortBy, sortDir } to be asserted
  // here, plus the detail-page contract (full Vehicle + Driver
  // objects nested on GET /:id).

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: TripsController;
  let adminId: string;
  let vehicle: Vehicle;
  let driver: Driver;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [TripsController],
      providers: [
        TripsService,
        PrismaService,
        // AUTH is required by AuthGuard's constructor. The override
        // below replaces the guard itself, but Nest still resolves
        // its dependencies — provide a benign stub so DI does not
        // fail on AUTH lookup.
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(TripsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    vehicle = await seedVehicle(prisma, adminId);
    driver = await seedDriver(prisma, adminId);
  });

  test("list() returns the documented response shape { items, total, skip, take, sortBy, sortDir }", async () => {
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
      status: TripStatus.COMPLETED,
      startedAt: new Date("2026-01-05T08:00:00Z"),
      endedAt: new Date("2026-01-06T18:00:00Z"),
    });

    const response = await controller.list({
      status: [TripStatus.COMPLETED],
      sortBy: "startedAt",
      sortDir: "asc",
      skip: 0,
      take: 10,
    });

    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "startedAt",
      sortDir: "asc",
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.status).toBe(TripStatus.COMPLETED);
    // List items carry the slim Vehicle + Driver projection — pinned
    // here at the controller layer too (in addition to the service-
    // layer test) so a future bypass of the LIST_SELECT that leaked
    // the full nested objects would fail.
    expect(response.items[0]?.vehicle.registrationNumber).toBe(vehicle.registrationNumber);
    expect(response.items[0]?.driver.fullName).toBe(driver.fullName);
  });

  test("empty query → controller applies defaults (sortBy=createdAt, sortDir=desc, skip=0, take=LIST_TAKE_DEFAULT)", async () => {
    await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
    });

    const response = await controller.list({});

    // LIST_TAKE_DEFAULT is 20 per trips.service.ts; pinned here so a
    // change to that constant surfaces in the test as well as in the
    // contract.
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("response.items and response.total agree when no pagination is applied", async () => {
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
    });
    await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.COMPLETED,
    });

    const response = await controller.list({});
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });

  test("vehicleId filter narrows the response items at the controller layer", async () => {
    const otherVehicle = await seedVehicle(prisma, adminId, {
      registrationNumber: "BA-99-OTHER",
    });
    await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
    });
    await seedTrip(prisma, {
      vehicleId: otherVehicle.id,
      driverId: driver.id,
      createdById: adminId,
    });

    const response = await controller.list({ vehicleId: vehicle.id });
    expect(response.total).toBe(1);
    expect(response.items[0]?.vehicleId).toBe(vehicle.id);
  });

  test("getById() returns the full Vehicle and Driver nested on the response", async () => {
    const created = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.COMPLETED,
      startedAt: new Date("2026-01-05T08:00:00Z"),
      endedAt: new Date("2026-01-06T18:00:00Z"),
      startOdometerKm: 80000,
      endOdometerKm: 80350,
      notes: "Pokhara delivery",
    });

    const response = await controller.getById(created.id);
    expect(response.id).toBe(created.id);
    // Full Vehicle and Driver objects — every column should be
    // present, not the slim list projection. Assert a few
    // distinguishing fields.
    expect(response.vehicle.make).toBe(vehicle.make);
    expect(response.vehicle.model).toBe(vehicle.model);
    expect(response.vehicle.year).toBe(vehicle.year);
    expect(response.driver.licenseClass).toBe(driver.licenseClass);
    expect(response.driver.phone).toBe(driver.phone);
    // Per-trip fields land in the response too.
    expect(response.startOdometerKm).toBe(80000);
    expect(response.endOdometerKm).toBe(80350);
    expect(response.notes).toBe("Pokhara delivery");
  });

  test("getById() of an unknown id throws NotFoundException (HTTP 404)", async () => {
    // Service returns null on findUnique miss; controller wraps that
    // into NotFoundException, which Nest's default exception filter
    // renders as HTTP 404 with the message in the body. The runbook
    // commits to "Trip {id} not found" wording; we assert the id
    // appears so a future message refactor that dropped it would fail.
    try {
      await controller.getById("nonexistent-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-id");
    }
  });
});
