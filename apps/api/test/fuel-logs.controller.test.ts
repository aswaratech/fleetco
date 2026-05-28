import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { FuelLogsController } from "../src/modules/fuel-logs/fuel-logs.controller";
import {
  CreateFuelLogSchema,
  ListFuelLogsQuerySchema,
  UpdateFuelLogSchema,
} from "../src/modules/fuel-logs/fuel-logs.schemas";
import { FuelLogsService } from "../src/modules/fuel-logs/fuel-logs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for FuelLogsController, mirror of the iter-17
// jobs.controller.test.ts file. Two-layer structure:
//
//   1. Schema/pipe layer: ZodValidationPipe applied to
//      ListFuelLogsQuerySchema. Whether a bogus query key surfaces
//      as HTTP 400 is a property of the schema's .strict() flag plus
//      the pipe's translation to BadRequestException — exercised
//      directly without booting an HTTP server.
//
//   2. Controller layer: FuelLogsController.list() / getById() called
//      against a real PrismaService + real FuelLogsService, with
//      AuthGuard overridden to pass-through. The response shape
//      { items, total, skip, take, sortBy, sortDir } is asserted
//      here per the iter-19 ticket spec.
//
// Auth-gate (real 401 without cookie) is intentionally NOT exercised
// here — auth.guard.test.ts already pins that path at the guard
// level. Mirror of every other controller test in this codebase.

describe("FuelLogsController list-query schema (iter-19 contract)", () => {
  const pipe = new ZodValidationPipe(ListFuelLogsQuerySchema);

  test("bogus query key (e.g. ?vehicelId=...) → BadRequestException (HTTP 400)", () => {
    // The schema is .strict(), so an unknown key fails parse(). The
    // pipe translates ZodError to BadRequestException. The runbook's
    // api-error-mapping table is the spec being verified here.
    expect(() => pipe.transform({ vehicelId: "c1234567890" })).toThrow(BadRequestException);
  });

  test("bogus sortBy (e.g. liters) → BadRequestException", () => {
    // The whitelist is date / createdAt. Liters / litersMl is
    // intentionally NOT sortable in iter 19 — the kickoff calls this
    // out explicitly. Any other column (including litersMl, vehicleId,
    // notes) returns 400.
    try {
      pipe.transform({ sortBy: "liters" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message;
      // The Zod enum's default error message includes the whitelist
      // values; pin that the response mentions the legal options so a
      // client developer can self-correct.
      expect(message.toLowerCase()).toContain("sortby");
    }
  });

  test("sortBy=notes is rejected (information-disclosure defense)", () => {
    // Pinned so a refactor that "helpfully" widens the whitelist to
    // all columns would fail loudly. Free-form notes content must
    // not be sortable. Same defense the Jobs / Trips schemas apply.
    expect(() => pipe.transform({ sortBy: "notes" })).toThrow(BadRequestException);
  });

  test("sortBy=station is rejected (off-whitelist)", () => {
    // Pinning that vendor-name sorting is off-whitelist too —
    // operators don't need to sort by station, and allowing it
    // would expose ordering information about vendor identity.
    expect(() => pipe.transform({ sortBy: "station" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException with field-named message", () => {
    // The schema mirrors the service's LIST_TAKE_MAX clamp at 200
    // and rejects above it. The error message names the field so the
    // client can surface it inline.
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

  test("invalid startDate (not a date) → BadRequestException", () => {
    expect(() => pipe.transform({ startDate: "not-a-date" })).toThrow(BadRequestException);
  });

  test("invalid vehicleId (not a cuid) → BadRequestException", () => {
    // The CuidFilter helper rejects values that don't match the
    // loose cuid shape. Pinned so a refactor that loosened the
    // filter to plain string would surface here.
    expect(() => pipe.transform({ vehicleId: "not-a-cuid" })).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (string → number, string → Date)", () => {
    const result = pipe.transform({
      vehicleId: "ckabc1234567890",
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      sortBy: "date",
      sortDir: "desc",
      skip: "10",
      take: "50",
    });
    expect(result.vehicleId).toBe("ckabc1234567890");
    expect(result.startDate).toBeInstanceOf(Date);
    expect(result.endDate).toBeInstanceOf(Date);
    expect(result.sortBy).toBe("date");
    expect(result.sortDir).toBe("desc");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → undefined fields (defaults applied at controller/service)", () => {
    // No filter/sort/paginate params should produce an all-undefined
    // shape so the controller can apply its defaults. The schema
    // must NOT eagerly default these — that's the controller's job
    // — because letting the schema default them would make it
    // impossible to distinguish "client didn't ask" from "client
    // asked for the default". Mirror of the Jobs / Customers test.
    const result = pipe.transform({});
    expect(result.vehicleId).toBeUndefined();
    expect(result.tripId).toBeUndefined();
    expect(result.startDate).toBeUndefined();
    expect(result.endDate).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });

  test("empty-string vehicleId is normalized to undefined (omit filter)", () => {
    // `?vehicleId=` from the URL surfaces as the empty string, which
    // we treat as "no filter" rather than "match the empty-string
    // id" (which would match zero rows). Mirror of the Jobs
    // customerId normalization.
    const result = pipe.transform({ vehicleId: "" });
    expect(result.vehicleId).toBeUndefined();
  });
});

describe("FuelLogsController.list (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: FuelLogsController;
  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [FuelLogsController],
      providers: [
        FuelLogsService,
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
    controller = module.get(FuelLogsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA 1 KA ${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
        kind: "TIPPER",
        make: "Tata",
        model: "LPK 2518",
        year: 2022,
        acquiredAt: new Date("2022-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    vehicleId = vehicle.id;
  });

  async function seedFuelLog(
    overrides: { date?: Date; vehicleId?: string; litersMl?: number } = {},
  ) {
    return prisma.fuelLog.create({
      data: {
        vehicleId: overrides.vehicleId ?? vehicleId,
        date: overrides.date ?? new Date("2026-02-15T08:00:00Z"),
        litersMl: overrides.litersMl ?? 12_345,
        pricePerLiterPaisa: 11_050,
        totalCostPaisa: 136_412,
        createdById: adminId,
      },
    });
  }

  test("happy path: response shape { items, total, skip, take, sortBy, sortDir } with slim vehicle+trip projection", async () => {
    await seedFuelLog();
    await seedFuelLog({ date: new Date("2026-02-20T08:00:00Z") });

    const response = await controller.list({
      vehicleId,
      sortBy: "date",
      sortDir: "desc",
      skip: 0,
      take: 10,
    });

    expect(response).toMatchObject({
      total: 2,
      skip: 0,
      take: 10,
      sortBy: "date",
      sortDir: "desc",
    });
    expect(response.items).toHaveLength(2);
    // The slim LIST_SELECT projection — pinned here so a refactor
    // that narrowed or widened the projection would surface as a
    // controller-test failure as well as a service-test failure.
    const first = response.items[0];
    expect(first.vehicle).toBeDefined();
    expect(first.vehicle.id).toBe(vehicleId);
    expect(first.vehicle.registrationNumber).toMatch(/^BA 1 KA/);
    // Default sort puts the 2026-02-20 row first.
    expect(first.date.toISOString()).toBe("2026-02-20T08:00:00.000Z");
  });

  test("empty query → controller applies defaults (sortBy=date, sortDir=desc, skip=0, take=LIST_TAKE_DEFAULT)", async () => {
    await seedFuelLog();

    const response = await controller.list({});

    expect(response.skip).toBe(0);
    // LIST_TAKE_DEFAULT is 20 per fuel-logs.service.ts; pinned here
    // so a change to that constant surfaces in the test as well as
    // in the contract.
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("date");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("response.items and response.total agree when no pagination is applied", async () => {
    // Sanity: total should equal items.length when the page contains
    // the whole result set. This protects against a regression in
    // the service's $transaction([findMany, count]) where the WHERE
    // clause differs between the two calls.
    await seedFuelLog();
    await seedFuelLog();
    await seedFuelLog();

    const response = await controller.list({});
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });

  test("vehicleId filter restricts results to that vehicle's fuel logs", async () => {
    const otherVehicle = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA 9 KA ${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
        kind: "TRUCK",
        make: "Ashok Leyland",
        model: "1616",
        year: 2023,
        acquiredAt: new Date("2023-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });

    await seedFuelLog();
    await seedFuelLog();
    await seedFuelLog({ vehicleId: otherVehicle.id });

    const response = await controller.list({ vehicleId: otherVehicle.id });
    expect(response.total).toBe(1);
    expect(response.items).toHaveLength(1);
    expect(response.items[0].vehicleId).toBe(otherVehicle.id);
  });
});

describe("FuelLogsController.getById (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: FuelLogsController;
  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [FuelLogsController],
      providers: [
        FuelLogsService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(FuelLogsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA 5 KA ${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
        kind: "TIPPER",
        make: "Tata",
        model: "LPK 2518",
        year: 2022,
        acquiredAt: new Date("2022-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    vehicleId = vehicle.id;
  });

  test("returns the row with the full nested vehicle when present (no trip)", async () => {
    // The DETAIL_INCLUDE shape includes `vehicle: true` (the full
    // record, not the slim list projection) so the detail page can
    // render every field and deep-link back to /vehicles/<id>.
    const created = await prisma.fuelLog.create({
      data: {
        vehicleId,
        date: new Date("2026-02-15T08:00:00Z"),
        litersMl: 12_345,
        pricePerLiterPaisa: 11_050,
        totalCostPaisa: 136_412,
        station: "NOC Naxal",
        createdById: adminId,
      },
    });

    const fetched = await controller.getById(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.station).toBe("NOC Naxal");
    expect(fetched.vehicle.id).toBe(vehicleId);
    expect(fetched.vehicle.registrationNumber).toMatch(/^BA 5 KA/);
    // No trip on this row — trip field should be null in the detail
    // response (the FuelLog.tripId column is nullable).
    expect(fetched.trip).toBeNull();
  });

  test("returns the row with both nested vehicle and trip when tripId is set", async () => {
    const driver = await prisma.driver.create({
      data: {
        fullName: "Ram Bahadur",
        licenseNumber: `12-345-${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
        licenseClass: "HTV",
        phone: "+977-9800000000",
        hiredAt: new Date("2022-01-15T00:00:00Z"),
        licenseExpiresAt: new Date("2030-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    const trip = await prisma.trip.create({
      data: {
        vehicleId,
        driverId: driver.id,
        status: "COMPLETED",
        startedAt: new Date("2026-02-10T06:00:00Z"),
        endedAt: new Date("2026-02-10T14:00:00Z"),
        startOdometerKm: 10000,
        endOdometerKm: 10250,
        createdById: adminId,
      },
    });
    const created = await prisma.fuelLog.create({
      data: {
        vehicleId,
        tripId: trip.id,
        date: new Date("2026-02-15T08:00:00Z"),
        litersMl: 12_345,
        pricePerLiterPaisa: 11_050,
        totalCostPaisa: 136_412,
        createdById: adminId,
      },
    });

    const fetched = await controller.getById(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.trip).not.toBeNull();
    expect(fetched.trip?.id).toBe(trip.id);
    expect(fetched.vehicle.id).toBe(vehicleId);
  });

  test("throws NotFoundException when the id does not exist (HTTP 404)", async () => {
    // The runbook's api-error-mapping table commits to P2025 / not-
    // found → 404 NotFoundException. The controller relies on the
    // service to throw, which Nest's default exception filter then
    // maps to HTTP 404 with the standard body.
    try {
      await controller.getById("nonexistent-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-id");
    }
  });
});

// ----------------------------------------------------------------
// iter-20: write-path schema (pipe) tests
// ----------------------------------------------------------------
// Pure pipe-level tests of CreateFuelLogSchema / UpdateFuelLogSchema.
// Cheap — no TestingModule. Mirror of the Jobs / Customers / Drivers
// write-schema pipe blocks.

describe("Fuel-logs write-path schemas (iter-20 contract, pipe layer)", () => {
  const createPipe = new ZodValidationPipe(CreateFuelLogSchema);
  const updatePipe = new ZodValidationPipe(UpdateFuelLogSchema);

  const validCreateBody = {
    vehicleId: "ckabc1234567890",
    date: "2026-02-15",
    litersMl: 12_345,
    pricePerLiterPaisa: 11_055,
  };

  test("CreateFuelLogSchema: valid minimal body parses (date coerced to Date)", () => {
    const parsed = createPipe.transform({ ...validCreateBody });
    expect(parsed.vehicleId).toBe("ckabc1234567890");
    expect(parsed.litersMl).toBe(12_345);
    expect(parsed.pricePerLiterPaisa).toBe(11_055);
    expect(parsed.date).toBeInstanceOf(Date);
    // The optional fields are absent in the parsed shape so the
    // service's `??` defaults apply (null at the column level).
    expect(parsed.tripId).toBeUndefined();
    expect(parsed.station).toBeUndefined();
  });

  test("CreateFuelLogSchema: server-controlled totalCostPaisa is rejected (.strict())", () => {
    // The iter-20 closure for CLAUDE.md §"Money & units": the wire
    // never carries totalCostPaisa. The .strict() rejects it as
    // an unknown key.
    expect(() => createPipe.transform({ ...validCreateBody, totalCostPaisa: 100_000 })).toThrow(
      BadRequestException,
    );
  });

  test("CreateFuelLogSchema: server-controlled createdById is rejected (.strict())", () => {
    // Same rule the every other write surface enforces. The
    // controller pulls createdById from request.session per ADR-0021.
    expect(() => createPipe.transform({ ...validCreateBody, createdById: "user_x" })).toThrow(
      BadRequestException,
    );
  });

  test("CreateFuelLogSchema: missing required vehicleId → 400", () => {
    expect(() =>
      createPipe.transform({
        date: "2026-02-15",
        litersMl: 12_345,
        pricePerLiterPaisa: 11_055,
      }),
    ).toThrow(BadRequestException);
  });

  test("CreateFuelLogSchema: litersMl below the floor → 400", () => {
    // 0 mL is a corrupted record per the schema docblock.
    expect(() => createPipe.transform({ ...validCreateBody, litersMl: 0 })).toThrow(
      BadRequestException,
    );
  });

  test("CreateFuelLogSchema: pricePerLiterPaisa above the ceiling → 400", () => {
    // PRICE_PAISA_MAX is 10_000_000 (NPR 100,000 / L). Anything
    // above is rejected — a typo'd extra digit fails the schema.
    expect(() =>
      createPipe.transform({ ...validCreateBody, pricePerLiterPaisa: 99_999_999 }),
    ).toThrow(BadRequestException);
  });

  test("CreateFuelLogSchema: invalid vehicleId shape (non-cuid) → 400", () => {
    expect(() => createPipe.transform({ ...validCreateBody, vehicleId: "not-a-cuid" })).toThrow(
      BadRequestException,
    );
  });

  test("UpdateFuelLogSchema: empty body → 400 (at-least-one-field refine)", () => {
    expect(() => updatePipe.transform({})).toThrow(BadRequestException);
  });

  test("UpdateFuelLogSchema: vehicleId is rejected (immutable on PATCH)", () => {
    // The PATCH schema deliberately omits vehicleId from its shape;
    // .strict() turns that into a 400 rather than silently dropping
    // the field. Iter-20 kickoff §"Immutability of vehicleId on
    // PATCH" pins this contract.
    expect(() => updatePipe.transform({ vehicleId: "ckabc1234567890" })).toThrow(
      BadRequestException,
    );
  });

  test("UpdateFuelLogSchema: totalCostPaisa is rejected (server-derived)", () => {
    expect(() => updatePipe.transform({ totalCostPaisa: 100_000 })).toThrow(BadRequestException);
  });

  test("UpdateFuelLogSchema: single-field tripId patch parses (mutable on PATCH)", () => {
    const parsed = updatePipe.transform({ tripId: "ckabcdef12345678" });
    expect(parsed.tripId).toBe("ckabcdef12345678");
  });

  test("UpdateFuelLogSchema: tripId = null parses (unpair semantics)", () => {
    const parsed = updatePipe.transform({ tripId: null });
    expect(parsed.tripId).toBeNull();
  });

  test("UpdateFuelLogSchema: bogus key is rejected (.strict())", () => {
    expect(() => updatePipe.transform({ totalCost: 100_000 })).toThrow(BadRequestException);
  });
});

// ----------------------------------------------------------------
// iter-20: controller create / update / remove (integration)
// ----------------------------------------------------------------
// Full controller-level integration for the write path: real
// FuelLogsController + FuelLogsService + PrismaService, AuthGuard
// overridden, AUTH stubbed. The controller's create() reads
// createdById from request.session.user.id; we hand it a minimal
// fake request cast — same approach the Jobs / Customers controller
// tests take.

describe("FuelLogsController.create / update / remove (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: FuelLogsController;
  let adminId: string;
  let vehicleAId: string;
  let vehicleBId: string;
  let tripId: string;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [FuelLogsController],
      providers: [
        FuelLogsService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(FuelLogsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: { id: adminId, email: `admin-${adminId}@fleetco.test`, name: "Test Admin" },
    });
    const vehicleA = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA 1 KA ${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
        kind: "TIPPER",
        make: "Tata",
        model: "LPK 2518",
        year: 2022,
        acquiredAt: new Date("2022-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    vehicleAId = vehicleA.id;
    const vehicleB = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA 2 KA ${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
        kind: "TRUCK",
        make: "Ashok Leyland",
        model: "1616",
        year: 2023,
        acquiredAt: new Date("2023-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    vehicleBId = vehicleB.id;
    const driver = await prisma.driver.create({
      data: {
        fullName: "Ram Bahadur",
        licenseNumber: `12-345-${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
        licenseClass: "HTV",
        phone: "+977-9800000000",
        hiredAt: new Date("2022-01-15T00:00:00Z"),
        licenseExpiresAt: new Date("2030-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    const trip = await prisma.trip.create({
      data: {
        vehicleId: vehicleAId,
        driverId: driver.id,
        status: "COMPLETED",
        startedAt: new Date("2026-02-10T06:00:00Z"),
        endedAt: new Date("2026-02-10T14:00:00Z"),
        startOdometerKm: 10000,
        endOdometerKm: 10250,
        createdById: adminId,
      },
    });
    tripId = trip.id;

    fakeRequest = { session: { user: { id: adminId } } } as unknown as AuthenticatedRequest;
  });

  test("create() persists with derived totalCostPaisa and createdById from session", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        litersMl: 12_345,
        pricePerLiterPaisa: 11_055,
        station: "NOC Naxal",
      },
      fakeRequest,
    );
    // round((12345 * 11055) / 1000) = round(136473.975) = 136474
    expect(created.totalCostPaisa).toBe(136_474);
    expect(created.createdById).toBe(adminId);
    expect(created.vehicle.id).toBe(vehicleAId);
  });

  test("create() with tripId paired to its vehicle returns the nested trip", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        tripId,
        date: new Date("2026-02-15T08:00:00Z"),
        litersMl: 10_000,
        pricePerLiterPaisa: 10_000,
      },
      fakeRequest,
    );
    expect(created.trip?.id).toBe(tripId);
    expect(created.totalCostPaisa).toBe(100_000);
  });

  test("create() with a trip-vehicle mismatch → BadRequestException (HTTP 400)", async () => {
    try {
      await controller.create(
        {
          vehicleId: vehicleBId,
          tripId,
          date: new Date("2026-02-15T08:00:00Z"),
          litersMl: 10_000,
          pricePerLiterPaisa: 10_000,
        },
        fakeRequest,
      );
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain(tripId);
    }
  });

  test("create() with a non-existent vehicleId → BadRequestException (P2003 → 400)", async () => {
    try {
      await controller.create(
        {
          vehicleId: "ckmissingvehicleid123456",
          date: new Date("2026-02-15T08:00:00Z"),
          litersMl: 10_000,
          pricePerLiterPaisa: 10_000,
        },
        fakeRequest,
      );
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain("ckmissingvehicleid123456");
      expect((error as BadRequestException).message).toContain("does not exist");
    }
  });

  test("update() applies a diff-PATCH (station only) and leaves totalCostPaisa untouched", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        litersMl: 12_345,
        pricePerLiterPaisa: 11_055,
        station: "NOC Naxal",
      },
      fakeRequest,
    );
    const updated = await controller.update(created.id, { station: "NOC Thapathali" });
    expect(updated.station).toBe("NOC Thapathali");
    expect(updated.litersMl).toBe(created.litersMl);
    expect(updated.totalCostPaisa).toBe(created.totalCostPaisa);
  });

  test("update() recomputes totalCostPaisa when only pricePerLiterPaisa is patched", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        litersMl: 12_345,
        pricePerLiterPaisa: 11_055,
      },
      fakeRequest,
    );
    const updated = await controller.update(created.id, { pricePerLiterPaisa: 15_025 });
    // round((12345 * 15025) / 1000) = round(185_483.625) = 185_484
    expect(updated.totalCostPaisa).toBe(185_484);
  });

  test("update() unknown id → NotFoundException (HTTP 404)", async () => {
    try {
      await controller.update("ckmissingfuellog12345678", { station: "anything" });
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("ckmissingfuellog12345678");
    }
  });

  test("remove() hard-deletes and resolves without a body; 404 on unknown id", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        litersMl: 10_000,
        pricePerLiterPaisa: 10_000,
      },
      fakeRequest,
    );
    const result = await controller.remove(created.id);
    expect(result).toBeUndefined();
    const refetched = await prisma.fuelLog.findUnique({ where: { id: created.id } });
    expect(refetched).toBeNull();

    try {
      await controller.remove("ckmissingfuellog12345678");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
    }
  });
});
