import { randomUUID } from "node:crypto";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { VehicleKind, VehicleStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { VehiclesController } from "../src/modules/vehicles/vehicles.controller";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import {
  ListVehiclesQuerySchema,
  type CreateVehicleInput,
} from "../src/modules/vehicles/vehicles.schemas";
import { ZodValidationPipe } from "../src/modules/vehicles/zod-validation.pipe";
import { resetDb } from "./db";

// Integration tests for VehiclesController, focused on the iter-4
// ListVehiclesQuerySchema contract (kickoff item 3d):
//   - bogus query key → 400 (.strict() on the schema)
//   - valid filter + sort + page → 200 with the documented response
//     shape { items, total, skip, take, sortBy, sortDir }
//
// The tests run at two levels because the contract has two layers:
//
//   1. Schema/pipe layer: ZodValidationPipe applied to
//      ListVehiclesQuerySchema. Whether a bogus query key surfaces as
//      HTTP 400 is a property of the schema's .strict() flag plus the
//      pipe's translation to BadRequestException — exercised directly
//      below without booting an HTTP server.
//
//   2. Controller layer: VehiclesController.list() called against a
//      real PrismaService + real VehiclesService, with the AuthGuard
//      overridden to a pass-through so the test does not need a
//      better-auth session. The response shape is asserted here.
//
// AuthGuard is overridden (not stubbed at the AUTH-provider layer like
// auth.guard.test.ts) because we are testing the controller's contract
// downstream of auth — every protected route per ADR-0021 requires a
// session at runtime, but in unit/integration tests for non-auth
// behavior we want the guard out of the way. This mirrors the standard
// NestJS test pattern of overrideGuard(AuthGuard).useValue({ canActivate
// → true }).

function makeCreateInput(overrides: Partial<CreateVehicleInput> = {}): CreateVehicleInput {
  return {
    registrationNumber: overrides.registrationNumber ?? `BA-1-KA-${randomUUID().slice(0, 4)}`,
    kind: overrides.kind ?? VehicleKind.TRUCK,
    make: overrides.make ?? "Tata",
    model: overrides.model ?? "LPK 2518",
    year: overrides.year ?? 2020,
    status: overrides.status,
    odometerStartKm: overrides.odometerStartKm,
    odometerCurrentKm: overrides.odometerCurrentKm,
    acquiredAt: overrides.acquiredAt ?? new Date("2024-01-15"),
  };
}

describe("VehiclesController list-query schema (iter-4 contract)", () => {
  // Pipe-level tests do not need a TestingModule — the pipe and schema
  // are pure code and can be tested directly. This is the cheapest way
  // to assert "bogus query key → 400" without booting Nest.
  const pipe = new ZodValidationPipe(ListVehiclesQuerySchema);

  test("bogus query key (e.g. ?kine=TRUCK) → BadRequestException (HTTP 400)", () => {
    // The schema is .strict(), so an unknown key fails parse(). The
    // pipe translates ZodError to BadRequestException. The runbook's
    // api-error-mapping table is the spec being verified here.
    expect(() => pipe.transform({ kine: "TRUCK" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    // The csvEnum transform rejects unknown enum members with a 400.
    // This sits next to the .strict() check above because both produce
    // 400 but via different code paths inside the schema.
    expect(() => pipe.transform({ status: "NONSENSE" })).toThrow(BadRequestException);
  });

  test("invalid sortBy column (off-whitelist) → BadRequestException", () => {
    // The whitelist is registrationNumber / odometerCurrentKm /
    // acquiredAt / createdAt. Any other column (including the
    // legitimate-looking `createdById`) returns 400. This is both a
    // schema check and an information-disclosure defense: refusing to
    // sort by createdById prevents leaking the implicit ordering of
    // admins by id.
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

  test("valid query passes through with parsed types (string → number, csv → array)", () => {
    // The transforms in vehicles.schemas.ts turn URL-shaped strings
    // into typed values: `skip=10` becomes the number 10;
    // `status=ACTIVE,IN_MAINTENANCE` becomes the array
    // [ACTIVE, IN_MAINTENANCE]. Pinning this conversion catches a
    // regression that would forward strings to the service layer
    // (where Prisma would reject them silently or noisily).
    const result = pipe.transform({
      status: "ACTIVE,IN_MAINTENANCE",
      kind: "TRUCK",
      sortBy: "registrationNumber",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual([VehicleStatus.ACTIVE, VehicleStatus.IN_MAINTENANCE]);
    expect(result.kind).toEqual([VehicleKind.TRUCK]);
    expect(result.sortBy).toBe("registrationNumber");
    expect(result.sortDir).toBe("asc");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → undefined fields (defaults applied at controller/service)", () => {
    // No filter/sort/paginate params should produce an all-undefined
    // shape so the controller can apply its defaults
    // (sortBy=createdAt, sortDir=desc, skip=0, take=DEFAULT_TAKE).
    // The schema must NOT eagerly default these — that's the
    // controller's job — because letting the schema default them
    // would make it impossible to distinguish "client didn't ask" from
    // "client asked for the default".
    const result = pipe.transform({});
    expect(result.status).toBeUndefined();
    expect(result.kind).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });
});

describe("VehiclesController.list (integration, real Prisma)", () => {
  // Full controller-level integration: a real VehiclesController with a
  // real VehiclesService and a real PrismaService, with AuthGuard
  // overridden to pass-through. The kickoff calls for the response
  // shape `{ items, total, skip, take, sortBy, sortDir }` to be
  // asserted here.

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: VehiclesController;
  let service: VehiclesService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [VehiclesController],
      providers: [
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
    service = module.get(VehiclesService);
    controller = module.get(VehiclesController);
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
    // Seed two vehicles so total > 0 and the response has visible
    // structure.
    await service.create(
      makeCreateInput({ registrationNumber: "BA-X-1", kind: VehicleKind.TRUCK }),
      adminId,
    );
    await service.create(
      makeCreateInput({ registrationNumber: "BA-X-2", kind: VehicleKind.TIPPER }),
      adminId,
    );

    // Call the controller directly with a query the pipe would have
    // produced from `?kind=TRUCK&sortBy=registrationNumber&sortDir=asc
    // &skip=0&take=10`. We pass typed values because the pipe's job
    // (asserted in the previous describe block) is to produce these
    // types; the controller's job (asserted here) is to consume them
    // correctly and shape the response.
    const response = await controller.list({
      kind: [VehicleKind.TRUCK],
      sortBy: "registrationNumber",
      sortDir: "asc",
      skip: 0,
      take: 10,
    });

    // Echoed-back keys: the controller mirrors the effective sort and
    // pagination in the response so the web client does not need to
    // re-parse them from the URL.
    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "registrationNumber",
      sortDir: "asc",
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.kind).toBe(VehicleKind.TRUCK);
  });

  test("empty query → controller applies defaults (sortBy=createdAt, sortDir=desc, skip=0, take=DEFAULT_TAKE)", async () => {
    await service.create(makeCreateInput(), adminId);

    const response = await controller.list({});

    // DEFAULT_TAKE is 20 per vehicles.service.ts; pinned here so a
    // change to that constant surfaces in the test as well as in the
    // contract.
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("response.items and response.total agree when no pagination is applied", async () => {
    // Sanity: total should equal items.length when the page contains
    // the whole result set. This protects against a regression in the
    // service's $transaction([findMany, count]) where the WHERE
    // clause differs between the two calls.
    await service.create(makeCreateInput({ registrationNumber: "BA-Y-1" }), adminId);
    await service.create(makeCreateInput({ registrationNumber: "BA-Y-2" }), adminId);
    await service.create(makeCreateInput({ registrationNumber: "BA-Y-3" }), adminId);

    const response = await controller.list({
      status: [VehicleStatus.ACTIVE],
    });
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });
});
