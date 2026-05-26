import { randomUUID } from "node:crypto";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DriverStatus, LicenseClass } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { DriversController } from "../src/modules/drivers/drivers.controller";
import { DriversService, type CreateDriverInput } from "../src/modules/drivers/drivers.service";
import { ListDriversQuerySchema } from "../src/modules/drivers/drivers.schemas";
import { PrismaService } from "../src/modules/prisma/prisma.service";
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
