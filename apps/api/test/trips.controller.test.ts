import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TripStatus, type Vehicle, type Driver } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsController } from "../src/modules/trips/trips.controller";
import { TripsService } from "../src/modules/trips/trips.service";
import {
  CreateTripSchema,
  ListTripsQuerySchema,
  UpdateTripSchema,
} from "../src/modules/trips/trips.schemas";
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

describe("TripsController write-path schemas (iter-9 contract)", () => {
  // Pipe-level tests for CreateTripSchema and UpdateTripSchema. Same
  // cheap pure-code approach as the iter-8 list-query tests above:
  // instantiate ZodValidationPipe directly, no TestingModule. The
  // runbook's api-error-mapping table commits ZodError →
  // BadRequestException → HTTP 400; these tests pin each branch.

  describe("CreateTripSchema", () => {
    const createPipe = new ZodValidationPipe(CreateTripSchema);

    test("bogus body key → BadRequestException (.strict() defense)", () => {
      // The schema is `.strict()` so a client cannot smuggle
      // `createdById` or `id` through the POST body. Same defense the
      // runbook lists for the list query and the Drivers/Vehicles
      // create surfaces.
      expect(() =>
        createPipe.transform({
          vehicleId: "vh_1",
          driverId: "dr_1",
          status: "PLANNED",
          createdById: "smuggled",
        }),
      ).toThrow(BadRequestException);
    });

    test("missing required field (no vehicleId) → BadRequestException", () => {
      expect(() =>
        createPipe.transform({
          driverId: "dr_1",
          status: "PLANNED",
        }),
      ).toThrow(BadRequestException);
    });

    test("invalid status enum → BadRequestException", () => {
      expect(() =>
        createPipe.transform({
          vehicleId: "vh_1",
          driverId: "dr_1",
          status: "NONSENSE",
        }),
      ).toThrow(BadRequestException);
    });

    test("COMPLETED without start/end fields → BadRequestException (cross-field)", () => {
      // superRefine runs validateTripCrossFields; COMPLETED requires
      // all four start/end fields. The runbook commits to surfacing
      // these as 400 with a per-field message rather than a 500 from
      // Prisma later.
      expect(() =>
        createPipe.transform({
          vehicleId: "vh_1",
          driverId: "dr_1",
          status: "COMPLETED",
        }),
      ).toThrow(BadRequestException);
    });

    test("COMPLETED with end before start → BadRequestException (cross-field)", () => {
      // The cross-field rule rejects endedAt < startedAt. Pinned to
      // catch a refactor that dropped the ordering check.
      expect(() =>
        createPipe.transform({
          vehicleId: "vh_1",
          driverId: "dr_1",
          status: "COMPLETED",
          startedAt: "2026-01-06T18:00:00Z",
          endedAt: "2026-01-05T08:00:00Z",
          startOdometerKm: 80000,
          endOdometerKm: 80100,
        }),
      ).toThrow(BadRequestException);
    });

    test("valid PLANNED body parses through (no odometer / no timestamps)", () => {
      const parsed = createPipe.transform({
        vehicleId: "vh_1",
        driverId: "dr_1",
        status: "PLANNED",
      });
      expect(parsed.vehicleId).toBe("vh_1");
      expect(parsed.status).toBe("PLANNED");
    });

    test("valid COMPLETED body parses through with all four start/end fields", () => {
      const parsed = createPipe.transform({
        vehicleId: "vh_1",
        driverId: "dr_1",
        status: "COMPLETED",
        startedAt: "2026-01-05T08:00:00Z",
        endedAt: "2026-01-06T18:00:00Z",
        startOdometerKm: 80000,
        endOdometerKm: 80350,
        notes: "Pokhara delivery",
      });
      expect(parsed.status).toBe("COMPLETED");
      expect(parsed.startOdometerKm).toBe(80000);
      expect(parsed.endOdometerKm).toBe(80350);
    });
  });

  describe("UpdateTripSchema", () => {
    const updatePipe = new ZodValidationPipe(UpdateTripSchema);

    test("bogus body key (e.g. id) → BadRequestException", () => {
      // The .strict() defense applies on PATCH too: a client cannot
      // smuggle `id` or `createdById` through the update body.
      expect(() => updatePipe.transform({ id: "smuggled" })).toThrow(BadRequestException);
    });

    test("single-field PATCH (just notes) parses through", () => {
      const parsed = updatePipe.transform({ notes: "Updated note" });
      expect(parsed.notes).toBe("Updated note");
    });

    test("explicit notes: null is accepted (the 'clear' branch)", () => {
      // notes is `.nullable().optional()` so an operator can clear a
      // previously-set value by sending null explicitly. The service
      // distinguishes "client provided null" from "client did not
      // mention" via hasOwnProperty; both branches need to parse
      // through here.
      const parsed = updatePipe.transform({ notes: null });
      expect(parsed.notes).toBeNull();
    });

    test("invalid odometer (negative) → BadRequestException", () => {
      expect(() => updatePipe.transform({ startOdometerKm: -1 })).toThrow(BadRequestException);
    });

    test("invalid datetime string → BadRequestException", () => {
      expect(() => updatePipe.transform({ startedAt: "not-a-datetime" })).toThrow(
        BadRequestException,
      );
    });
  });
});

describe("TripsController.create / update / remove (integration, real Prisma)", () => {
  // Full controller-level integration for the iter-9 write path. Same
  // TestingModule shape as the list integration above: real
  // TripsController + TripsService + PrismaService, AuthGuard
  // overridden to pass-through, AUTH provider stubbed. The kickoff
  // (iter-9 deliverable 4) is the spec under test here — HTTP status
  // codes are checked via the @HttpCode decorator's effect indirectly
  // (we call controller methods directly, not through an HTTP server),
  // so the assertions focus on the response body shape, the NotFound /
  // BadRequest paths, and the side effects (DB row created / updated /
  // removed).

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: TripsController;
  let service: TripsService;
  let adminId: string;
  let vehicle: Vehicle;
  let driver: Driver;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [TripsController],
      providers: [
        TripsService,
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
    service = module.get(TripsService);
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
    // The controller reads `request.session.user.id`. In production the
    // AuthGuard populates request.session per ADR-0021; here the guard
    // is overridden, so we hand the controller a minimal fake. Cast is
    // necessary because AuthenticatedRequest extends express.Request,
    // which we don't construct in full.
    fakeRequest = { session: { user: { id: adminId } } } as unknown as AuthenticatedRequest;
  });

  test("create() persists the trip with createdById from the session (HTTP 201)", async () => {
    // The body shape here matches what ZodValidationPipe would emit
    // after parsing the wire JSON. The kickoff spec: createdById comes
    // from the session, not the body (the schema's .strict() rejects
    // it). The @HttpCode(HttpStatus.CREATED) decorator on the route
    // ensures the framework returns 201; calling the controller method
    // directly bypasses that, but the path is exercised via the
    // declared signature.
    const created = await controller.create(
      {
        vehicleId: vehicle.id,
        driverId: driver.id,
        status: TripStatus.PLANNED,
      },
      fakeRequest,
    );
    expect(created.id).toBeTruthy();
    expect(created.status).toBe(TripStatus.PLANNED);
    expect(created.createdById).toBe(adminId);
    // Detail-shape contract: the full nested Vehicle and Driver
    // objects come back on the create response too (the service
    // returns via DETAIL_INCLUDE). Pinned so a refactor that returned
    // the slim list projection on create would fail.
    expect(created.vehicle.id).toBe(vehicle.id);
    expect(created.driver.id).toBe(driver.id);

    const refetched = await prisma.trip.findUnique({ where: { id: created.id } });
    expect(refetched?.createdById).toBe(adminId);
  });

  test("create() with unknown vehicleId → BadRequestException naming vehicle", async () => {
    // P2003 → BadRequestException with the FK name in the message.
    // The runbook commits to "vehicle" being mentioned so the web
    // client can surface a per-field error to the operator.
    try {
      await controller.create(
        {
          vehicleId: "nonexistent-vehicle",
          driverId: driver.id,
          status: TripStatus.PLANNED,
        },
        fakeRequest,
      );
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message.toLowerCase()).toContain("vehicle");
    }
  });

  test("update() returns the updated trip on success", async () => {
    const before = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.PLANNED,
      notes: "original note",
    });

    const after = await controller.update(before.id, { notes: "Updated note" });
    expect(after.id).toBe(before.id);
    expect(after.notes).toBe("Updated note");
    // Other fields stay put — diff-PATCH semantics confirmed at the
    // controller level.
    expect(after.status).toBe(TripStatus.PLANNED);
  });

  test("update() applying a legal status transition returns the new status", async () => {
    // PLANNED → IN_PROGRESS requires startedAt + startOdometerKm
    // (the cross-field rule on the merged shape). The service applies
    // the validator and writes both fields.
    const before = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.PLANNED,
    });

    const after = await controller.update(before.id, {
      status: TripStatus.IN_PROGRESS,
      startedAt: new Date("2026-02-01T08:00:00Z").toISOString(),
      startOdometerKm: 80000,
    });
    expect(after.status).toBe(TripStatus.IN_PROGRESS);
    expect(after.startOdometerKm).toBe(80000);
  });

  test("update() with illegal status transition throws BadRequestException", async () => {
    // PLANNED → COMPLETED is illegal (must go via IN_PROGRESS). The
    // service throws BadRequestException; Nest's default exception
    // filter renders this as HTTP 400.
    const before = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.PLANNED,
    });

    try {
      await controller.update(before.id, {
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-02-01T08:00:00Z").toISOString(),
        endedAt: new Date("2026-02-02T18:00:00Z").toISOString(),
        startOdometerKm: 80000,
        endOdometerKm: 80350,
      });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
    }
  });

  test("update() of an unknown id throws NotFoundException (HTTP 404)", async () => {
    try {
      await controller.update("nonexistent-id", { notes: "X" });
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-id");
    }
  });

  test("remove() deletes the row and resolves without a body (HTTP 204)", async () => {
    const created = await service.create(
      {
        vehicleId: vehicle.id,
        driverId: driver.id,
        status: TripStatus.PLANNED,
      },
      adminId,
    );

    // @HttpCode(HttpStatus.NO_CONTENT) is applied at the decorator
    // level; calling the method directly we only see the resolved
    // value (void). The HTTP status is verified indirectly via the
    // method's declared return type — if a refactor changed remove()
    // to return a body, the type system would catch it.
    const result = await controller.remove(created.id);
    expect(result).toBeUndefined();

    const refetched = await prisma.trip.findUnique({ where: { id: created.id } });
    expect(refetched).toBeNull();
  });

  test("remove() of an unknown id throws NotFoundException (HTTP 404)", async () => {
    try {
      await controller.remove("nonexistent-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-id");
    }
  });
});
