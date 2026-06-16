import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DriverStatus, LicenseClass, TripStatus, VehicleKind, VehicleStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { DriversController } from "../src/modules/drivers/drivers.controller";
import { DriversService, type CreateDriverInput } from "../src/modules/drivers/drivers.service";
import {
  CreateDriverSchema,
  ListDriversQuerySchema,
  UpdateDriverSchema,
} from "../src/modules/drivers/drivers.schemas";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsService } from "../src/modules/trips/trips.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { resetDb } from "./db";

// Integration tests for DriversController, focused on the iter-6
// ListDriversQuerySchema contract (kickoff item 5):
//   - bogus query key → 400 (.strict() on the schema)
//   - invalid enum value → 400
//   - off-whitelist sortBy → 400
//   - take above the 200 ceiling → 400
//   - valid filter + sort + page → 200 with the documented response
//     shape { items, total, skip, take, sortBy, sortDir }
//
// Two-layer structure mirrors vehicles.controller.test.ts:
//   1. Schema/pipe layer: ZodValidationPipe applied to
//      ListDriversQuerySchema. Whether a bogus query key surfaces as
//      HTTP 400 is a property of the schema's .strict() flag plus the
//      pipe's translation to BadRequestException — exercised directly
//      below without booting an HTTP server.
//
//   2. Controller layer: DriversController.list() called against a
//      real PrismaService + real DriversService, with AuthGuard
//      overridden to pass-through so the test does not need a
//      better-auth session. The response shape is asserted here.

function makeCreateInput(overrides: Partial<CreateDriverInput> = {}): CreateDriverInput {
  return {
    fullName: overrides.fullName ?? "Ram Bahadur Shrestha",
    licenseNumber: overrides.licenseNumber ?? `LIC-${randomUUID().slice(0, 8)}`,
    licenseClass: overrides.licenseClass ?? LicenseClass.HMV,
    phone: overrides.phone ?? "+977-9800000000",
    dateOfBirth: overrides.dateOfBirth,
    hiredAt: overrides.hiredAt ?? new Date("2022-04-01"),
    licenseExpiresAt: overrides.licenseExpiresAt ?? new Date("2028-04-01"),
    status: overrides.status,
  };
}

describe("DriversController list-query schema (iter-6 contract)", () => {
  // Pipe-level tests do not need a TestingModule — the pipe and schema
  // are pure code and can be tested directly. This is the cheapest way
  // to assert "bogus query key → 400" without booting Nest.
  const pipe = new ZodValidationPipe(ListDriversQuerySchema);

  test("bogus query key (e.g. ?licenseclas=HTV) → BadRequestException (HTTP 400)", () => {
    // The schema is .strict(), so an unknown key fails parse(). The
    // pipe translates ZodError to BadRequestException. The runbook's
    // api-error-mapping table is the spec being verified here.
    expect(() => pipe.transform({ licenseclas: "HTV" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    // The csvEnum transform rejects unknown enum members with a 400.
    // This sits next to the .strict() check above because both produce
    // 400 but via different code paths inside the schema.
    expect(() => pipe.transform({ status: "NONSENSE" })).toThrow(BadRequestException);
  });

  test("invalid licenseClass enum value → BadRequestException", () => {
    // HGMV is a legitimate Nepal DoTM class outside the Phase-1
    // heavy-construction taxonomy (LMV/HMV/HTV/HPMV); the schema must
    // reject it for now. If a future ADR adds HGMV the enum widens
    // and this test will need to follow.
    expect(() => pipe.transform({ licenseClass: "HGMV" })).toThrow(BadRequestException);
  });

  test("invalid sortBy column (off-whitelist) → BadRequestException", () => {
    // The whitelist is fullName / hiredAt / licenseExpiresAt /
    // createdAt. Any other column (including legitimate-looking
    // `licenseNumber` or `phone`) returns 400. This is both a schema
    // check and an information-disclosure defense: refusing to sort
    // by `phone` prevents leaking ordering information about Tier 2
    // PII.
    expect(() => pipe.transform({ sortBy: "phone" })).toThrow(BadRequestException);
  });

  test("sortBy=createdById is rejected (information-disclosure defense)", () => {
    // Even an internal admin-only field that exists on the row is
    // off-whitelist. Pinned so a refactor that "helpfully" widens the
    // whitelist to all columns would fail loudly.
    expect(() => pipe.transform({ sortBy: "createdById" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException with field-named message", () => {
    // The schema mirrors the service's MAX_TAKE clamp at 200 and
    // rejects above it. The error message names the field so the
    // client can surface it inline.
    try {
      pipe.transform({ take: "999" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message;
      // The pipe joins issues as "<path>: <reason>"; we assert the
      // path name appears so a future refactor that drops the path
      // would fail loudly.
      expect(message.toLowerCase()).toContain("take");
    }
  });

  test("skip below zero → BadRequestException", () => {
    expect(() => pipe.transform({ skip: "-1" })).toThrow(BadRequestException);
  });

  test("non-integer take → BadRequestException", () => {
    expect(() => pipe.transform({ take: "abc" })).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (string → number, csv → array)", () => {
    // The transforms in drivers.schemas.ts turn URL-shaped strings
    // into typed values: `skip=10` becomes the number 10;
    // `status=ACTIVE,ON_LEAVE` becomes the array [ACTIVE, ON_LEAVE].
    // Pinning this conversion catches a regression that would
    // forward strings to the service layer (where Prisma would
    // reject them silently or noisily).
    const result = pipe.transform({
      status: "ACTIVE,ON_LEAVE",
      licenseClass: "HMV,HTV",
      sortBy: "fullName",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual([DriverStatus.ACTIVE, DriverStatus.ON_LEAVE]);
    expect(result.licenseClass).toEqual([LicenseClass.HMV, LicenseClass.HTV]);
    expect(result.sortBy).toBe("fullName");
    expect(result.sortDir).toBe("asc");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → undefined fields (defaults applied at controller/service)", () => {
    // No filter/sort/paginate params should produce an all-undefined
    // shape so the controller can apply its defaults
    // (sortBy=createdAt, sortDir=desc, skip=0, take=LIST_TAKE_DEFAULT).
    // The schema must NOT eagerly default these — that's the
    // controller's job — because letting the schema default them
    // would make it impossible to distinguish "client didn't ask"
    // from "client asked for the default".
    const result = pipe.transform({});
    expect(result.status).toBeUndefined();
    expect(result.licenseClass).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });
});

describe("DriversController.list (integration, real Prisma)", () => {
  // Full controller-level integration: a real DriversController with a
  // real DriversService and a real PrismaService, with AuthGuard
  // overridden to pass-through. The kickoff calls for the response
  // shape { items, total, skip, take, sortBy, sortDir } to be
  // asserted here.

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: DriversController;
  let service: DriversService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [DriversController],
      providers: [
        DriversService,
        // DriversController gained a TripsService dep in iter 13 for
        // the GET /:id/stats route; supply both services so DI
        // resolves. VehiclesService is not directly injected but is a
        // peer of the TripsService aggregation surface in fleet code;
        // providing it keeps the module setup symmetric with the
        // iter-12 vehicles.controller.test.ts and tolerates a future
        // refactor that pulled VehiclesService into the controller.
        TripsService,
        DriverScopeService,
        VehiclesService,
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
    service = module.get(DriversService);
    controller = module.get(DriversController);
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
  });

  test("valid filter+sort+page returns response shape { items, total, skip, take, sortBy, sortDir }", async () => {
    // Seed two drivers so total > 0 and the response has visible
    // structure.
    await service.create(
      makeCreateInput({ licenseNumber: "LIC-X-1", licenseClass: LicenseClass.HMV }),
      adminId,
    );
    await service.create(
      makeCreateInput({ licenseNumber: "LIC-X-2", licenseClass: LicenseClass.HTV }),
      adminId,
    );

    // Call the controller directly with a query the pipe would have
    // produced from `?licenseClass=HMV&sortBy=fullName&sortDir=asc
    // &skip=0&take=10`. We pass typed values because the pipe's job
    // (asserted in the previous describe block) is to produce these
    // types; the controller's job (asserted here) is to consume them
    // correctly and shape the response.
    const response = await controller.list({
      licenseClass: [LicenseClass.HMV],
      sortBy: "fullName",
      sortDir: "asc",
      skip: 0,
      take: 10,
    });

    // Echoed-back keys: the controller mirrors the effective sort
    // and pagination in the response so the web client does not
    // need to re-parse them from the URL.
    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "fullName",
      sortDir: "asc",
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.licenseClass).toBe(LicenseClass.HMV);
  });

  test("empty query → controller applies defaults (sortBy=createdAt, sortDir=desc, skip=0, take=LIST_TAKE_DEFAULT)", async () => {
    await service.create(makeCreateInput(), adminId);

    const response = await controller.list({});

    // LIST_TAKE_DEFAULT is 20 per drivers.service.ts; pinned here so
    // a change to that constant surfaces in the test as well as in
    // the contract.
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("response.items and response.total agree when no pagination is applied", async () => {
    // Sanity: total should equal items.length when the page contains
    // the whole result set. This protects against a regression in the
    // service's $transaction([findMany, count]) where the WHERE clause
    // differs between the two calls.
    await service.create(makeCreateInput({ licenseNumber: "LIC-Y-1" }), adminId);
    await service.create(makeCreateInput({ licenseNumber: "LIC-Y-2" }), adminId);
    await service.create(makeCreateInput({ licenseNumber: "LIC-Y-3" }), adminId);

    const response = await controller.list({
      status: [DriverStatus.ACTIVE],
    });
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });
});

describe("DriversController write-path schemas (iter-7 contract)", () => {
  // Pipe-level tests for CreateDriverSchema and UpdateDriverSchema —
  // the iter-7 write-path schemas. Same cheap pure-code approach as
  // the iter-6 list-query tests above: instantiate ZodValidationPipe
  // directly, no TestingModule. The runbook's api-error-mapping table
  // commits ZodError → BadRequestException → HTTP 400; these tests pin
  // each branch.

  describe("CreateDriverSchema", () => {
    const createPipe = new ZodValidationPipe(CreateDriverSchema);

    test("bogus body key → BadRequestException (.strict() defense)", () => {
      // The schema is `.strict()` so a client cannot smuggle
      // `createdById` or other server-controlled fields through the
      // POST body. Same defense the runbook lists for the list query.
      expect(() =>
        createPipe.transform({
          fullName: "Ram Bahadur",
          licenseNumber: "LIC-001",
          licenseClass: "HMV",
          phone: "+977-9800000000",
          hiredAt: "2022-04-01",
          licenseExpiresAt: "2028-04-01",
          createdById: "smuggled-in",
        }),
      ).toThrow(BadRequestException);
    });

    test("missing required field (no fullName) → BadRequestException", () => {
      // The required-field set is documented inline in CreateDriverSchema
      // (fullName / licenseNumber / licenseClass / phone / hiredAt /
      // licenseExpiresAt). status is optional; dateOfBirth is optional.
      expect(() =>
        createPipe.transform({
          licenseNumber: "LIC-001",
          licenseClass: "HMV",
          phone: "+977-9800000000",
          hiredAt: "2022-04-01",
          licenseExpiresAt: "2028-04-01",
        }),
      ).toThrow(BadRequestException);
    });

    test("invalid Nepal phone shape → BadRequestException", () => {
      // The phone regex is deliberately loose (CLAUDE.md forbids
      // tightening without an ADR) but does reject clearly wrong
      // shapes — a US-style 555-123-4567 has the wrong leading digit
      // pattern for the Nepali regex's local arm. Pinning a known
      // rejection so a refactor that drops the regex would fail.
      expect(() =>
        createPipe.transform({
          fullName: "Ram Bahadur",
          licenseNumber: "LIC-001",
          licenseClass: "HMV",
          phone: "abc-not-a-phone",
          hiredAt: "2022-04-01",
          licenseExpiresAt: "2028-04-01",
        }),
      ).toThrow(BadRequestException);
    });

    test("invalid date string → BadRequestException", () => {
      // DateInput uses z.coerce.date(); a string that doesn't parse to
      // a real Date fails the pipe with the schema's friendlier
      // "Invalid date" message.
      expect(() =>
        createPipe.transform({
          fullName: "Ram Bahadur",
          licenseNumber: "LIC-001",
          licenseClass: "HMV",
          phone: "+977-9800000000",
          hiredAt: "not-a-date",
          licenseExpiresAt: "2028-04-01",
        }),
      ).toThrow(BadRequestException);
    });

    test("invalid licenseClass enum → BadRequestException", () => {
      expect(() =>
        createPipe.transform({
          fullName: "Ram Bahadur",
          licenseNumber: "LIC-001",
          licenseClass: "NOT_A_CLASS",
          phone: "+977-9800000000",
          hiredAt: "2022-04-01",
          licenseExpiresAt: "2028-04-01",
        }),
      ).toThrow(BadRequestException);
    });

    test("valid minimal body (no status, no dateOfBirth) parses through with coerced dates", () => {
      // status and dateOfBirth are optional; the parse should succeed
      // and produce Date instances for hiredAt / licenseExpiresAt.
      const parsed = createPipe.transform({
        fullName: "Ram Bahadur",
        licenseNumber: "LIC-001",
        licenseClass: "HMV",
        phone: "+977-9800000000",
        hiredAt: "2022-04-01",
        licenseExpiresAt: "2028-04-01",
      });
      expect(parsed.fullName).toBe("Ram Bahadur");
      expect(parsed.hiredAt).toBeInstanceOf(Date);
      expect(parsed.licenseExpiresAt).toBeInstanceOf(Date);
      expect(parsed.status).toBeUndefined();
      expect(parsed.dateOfBirth).toBeUndefined();
    });
  });

  describe("UpdateDriverSchema", () => {
    const updatePipe = new ZodValidationPipe(UpdateDriverSchema);

    test("empty body → BadRequestException (the at-least-one-field refine)", () => {
      // An empty PATCH would silently 200 with no change if we let it
      // through; instead the schema refines on `Object.keys(data).length`
      // so the client sees a clear 400. Pinned because dropping the
      // refine would make every empty PATCH a no-op success.
      expect(() => updatePipe.transform({})).toThrow(BadRequestException);
    });

    test("bogus body key (e.g. id) → BadRequestException", () => {
      // The .strict() defense applies on PATCH too: a client cannot
      // smuggle `id` or `createdById` or any other server-controlled
      // field through the update body.
      expect(() => updatePipe.transform({ id: "smuggled" })).toThrow(BadRequestException);
    });

    test("single-field PATCH (just fullName) parses through", () => {
      const parsed = updatePipe.transform({ fullName: "Renamed Driver" });
      expect(parsed.fullName).toBe("Renamed Driver");
    });

    test("explicit terminatedAt: null is accepted (the 'clear' branch)", () => {
      // The schema declares terminatedAt as `.nullable().optional()`
      // so an operator can clear a previously-set terminatedAt by
      // sending null explicitly. The service distinguishes "client
      // provided null" from "client did not mention" via
      // hasOwnProperty; both branches need to parse through here.
      const parsed = updatePipe.transform({ terminatedAt: null });
      expect(parsed.terminatedAt).toBeNull();
    });

    test("invalid date inside an otherwise valid PATCH → BadRequestException", () => {
      expect(() => updatePipe.transform({ hiredAt: "not-a-date" })).toThrow(BadRequestException);
    });
  });
});

describe("DriversController.create / update / remove (integration, real Prisma)", () => {
  // Full controller-level integration for the iter-7 write path. Same
  // TestingModule shape as the list integration above: real
  // DriversController + DriversService + PrismaService, AuthGuard
  // overridden to pass-through, AUTH provider stubbed. The kickoff
  // (iter-7 deliverable 2) is the spec under test here — HTTP status
  // codes are checked via the @HttpCode decorator's effect indirectly
  // (we call controller methods directly, not through an HTTP server),
  // so the assertions focus on the response body shape, the NotFound
  // path, and the side effects (DB row created / updated / removed).

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: DriversController;
  let service: DriversService;
  let adminId: string;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [DriversController],
      providers: [
        DriversService,
        // iter-13: TripsService is a constructor dep of
        // DriversController for the GET /:id/stats route. Even though
        // this write-path block does not exercise that route, Nest
        // still resolves all controller deps at module init.
        TripsService,
        DriverScopeService,
        VehiclesService,
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
    service = module.get(DriversService);
    controller = module.get(DriversController);
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
    // The controller reads `request.session.user.id`. In production the
    // AuthGuard populates request.session per ADR-0021; here the guard
    // is overridden, so we hand the controller a minimal fake. Cast is
    // necessary because AuthenticatedRequest extends express.Request,
    // which we don't construct in full.
    fakeRequest = { session: { user: { id: adminId } } } as unknown as AuthenticatedRequest;
  });

  test("create() persists the driver with createdById from the session", async () => {
    // The body shape here matches what ZodValidationPipe would emit
    // after parsing the wire JSON — Date instances rather than ISO
    // strings, no `createdById` (the schema's .strict() rejects it).
    const created = await controller.create(
      {
        fullName: "Sita Pradhan",
        licenseNumber: "LIC-CREATE-001",
        licenseClass: LicenseClass.HMV,
        phone: "+977-9811111111",
        hiredAt: new Date("2023-01-15"),
        licenseExpiresAt: new Date("2029-01-15"),
      },
      fakeRequest,
    );
    expect(created.id).toBeTruthy();
    expect(created.fullName).toBe("Sita Pradhan");
    // The kickoff spec: createdById comes from the session, not the
    // body. Pinning that path so a refactor that accidentally reads
    // it from the body would fail.
    expect(created.createdById).toBe(adminId);

    const refetched = await prisma.driver.findUnique({ where: { id: created.id } });
    expect(refetched?.licenseNumber).toBe("LIC-CREATE-001");
  });

  test("update() returns the updated driver on success", async () => {
    const before = await service.create(
      {
        fullName: "Original Name",
        licenseNumber: "LIC-UPDATE-001",
        licenseClass: LicenseClass.LMV,
        phone: "+977-9812222222",
        hiredAt: new Date("2022-04-01"),
        licenseExpiresAt: new Date("2028-04-01"),
      },
      adminId,
    );

    const after = await controller.update(before.id, { fullName: "Renamed" });
    expect(after.id).toBe(before.id);
    expect(after.fullName).toBe("Renamed");
    // Other fields stay put — diff-PATCH semantics confirmed at the
    // controller level (the service layer's tests cover the broader
    // matrix; this is the controller's contract that "the response
    // body reflects the post-update state, not just the patch input").
    expect(after.licenseNumber).toBe("LIC-UPDATE-001");
  });

  test("update() of an unknown id throws NotFoundException (HTTP 404)", async () => {
    // The service returns null when findUnique misses; the controller
    // translates that into NotFoundException, which Nest's default
    // exception filter renders as HTTP 404 with the message in the
    // body. The runbook commits to "Driver {id} not found" wording;
    // we assert the id appears so a future message refactor that
    // dropped it would fail.
    try {
      await controller.update("nonexistent-id", { fullName: "X" });
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-id");
    }
  });

  test("remove() deletes the row and resolves without a body", async () => {
    const created = await service.create(
      {
        fullName: "To Be Deleted",
        licenseNumber: "LIC-DELETE-001",
        licenseClass: LicenseClass.HTV,
        phone: "+977-9813333333",
        hiredAt: new Date("2022-04-01"),
        licenseExpiresAt: new Date("2028-04-01"),
      },
      adminId,
    );

    // @HttpCode(HttpStatus.NO_CONTENT) is applied at the decorator
    // level; calling the method directly we only see the resolved
    // value (void). The HTTP status is verified indirectly via the
    // method's declared return type — if a refactor changed
    // remove() to return a body, the type system would catch it.
    const result = await controller.remove(created.id);
    expect(result).toBeUndefined();

    const refetched = await prisma.driver.findUnique({ where: { id: created.id } });
    expect(refetched).toBeNull();
  });

  test("remove() of an unknown id throws NotFoundException (HTTP 404)", async () => {
    // Service returns false on P2025; controller throws
    // NotFoundException with the id named in the message.
    try {
      await controller.remove("nonexistent-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-id");
    }
  });
});

describe("DriversController.getStats (iter-13 cross-slice read)", () => {
  // Integration coverage for GET /api/v1/drivers/:id/stats. The
  // service-side aggregation logic is covered in trips.service.test.ts;
  // this block pins the controller's contract: existence check, the
  // ISO-string serialization of mostRecentVehicle.startedAt, and the
  // basic happy / empty paths. Mirror of the iter-12
  // VehiclesController.getStats describe block.

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: DriversController;
  let driversService: DriversService;
  let vehiclesService: VehiclesService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [DriversController],
      providers: [
        DriversService,
        TripsService,
        DriverScopeService,
        VehiclesService,
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
    driversService = module.get(DriversService);
    vehiclesService = module.get(VehiclesService);
    controller = module.get(DriversController);
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
  });

  // Local helpers — the trip-fixture seedTrip uses Prisma directly,
  // and the create paths through the services already cover the
  // schema-validation surface. Building rows directly via Prisma here
  // matches the iter-12 VehiclesController.getStats block exactly.
  async function makeDriver(suffix: string = randomUUID().slice(0, 8)) {
    return driversService.create(
      {
        fullName: `Test Driver ${suffix}`,
        licenseNumber: `LIC-${suffix}`,
        licenseClass: LicenseClass.HMV,
        phone: "+977-9800000000",
        hiredAt: new Date("2022-04-01"),
        licenseExpiresAt: new Date("2028-04-01"),
      },
      adminId,
    );
  }

  async function makeVehicle(suffix: string = randomUUID().slice(0, 4)) {
    return vehiclesService.create(
      {
        registrationNumber: `BA-1-PA-${suffix}`,
        kind: VehicleKind.TRUCK,
        make: "Tata",
        model: "LPK 2518",
        year: 2018,
        odometerStartKm: 0,
        odometerCurrentKm: 80000,
        acquiredAt: new Date("2018-06-01"),
        status: VehicleStatus.ACTIVE,
      },
      adminId,
    );
  }

  test("unknown driver id → NotFoundException (HTTP 404)", async () => {
    // The route checks existence via drivers.findById before
    // delegating to the aggregation. Without the check the response
    // would be `{ count: 0, total: 0, mostRecentVehicle: null }` for
    // any garbage id, which would be misleading. Pinned so a refactor
    // that drops the existence check would fail loudly.
    try {
      await controller.getStats("nonexistent-driver-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-driver-id");
    }
  });

  test("driver with zero trips → wire shape with zeros + null vehicle", async () => {
    const driver = await makeDriver();

    const stats = await controller.getStats(driver.id);
    expect(stats).toEqual({
      driverId: driver.id,
      completedTripCount: 0,
      totalKmLogged: 0,
      mostRecentVehicle: null,
    });
  });

  test("happy path → mostRecentVehicle.startedAt is an ISO string (not a Date)", async () => {
    // The service returns a Date; the controller converts to ISO for
    // the wire. Pin this so a refactor that forwards the service
    // shape unchanged would fail (Date.prototype.toISOString call
    // dropped). The Drivers and Vehicles slices follow the same wire
    // convention: dates cross the API boundary as ISO strings.
    const driver = await makeDriver();
    const vehicle = await makeVehicle();
    await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date("2026-04-15T08:00:00Z"),
        startOdometerKm: 1000,
      },
    });

    const stats = await controller.getStats(driver.id);
    expect(stats.mostRecentVehicle).not.toBeNull();
    expect(stats.mostRecentVehicle?.id).toBe(vehicle.id);
    expect(stats.mostRecentVehicle?.registrationNumber).toBe(vehicle.registrationNumber);
    expect(typeof stats.mostRecentVehicle?.startedAt).toBe("string");
    expect(stats.mostRecentVehicle?.startedAt).toBe("2026-04-15T08:00:00.000Z");
  });

  test("happy path with COMPLETED trips → completedTripCount + totalKmLogged populated", async () => {
    const driver = await makeDriver();
    const vehicle = await makeVehicle();
    // Two COMPLETED trips covering 350 km combined.
    await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-10T08:00:00Z"),
        endedAt: new Date("2026-04-10T18:00:00Z"),
        startOdometerKm: 500,
        endOdometerKm: 700,
      },
    });
    await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.COMPLETED,
        startedAt: new Date("2026-04-12T08:00:00Z"),
        endedAt: new Date("2026-04-12T18:00:00Z"),
        startOdometerKm: 700,
        endOdometerKm: 850,
      },
    });

    const stats = await controller.getStats(driver.id);
    expect(stats.completedTripCount).toBe(2);
    expect(stats.totalKmLogged).toBe(350);
    expect(stats.mostRecentVehicle?.id).toBe(vehicle.id);
  });
});
