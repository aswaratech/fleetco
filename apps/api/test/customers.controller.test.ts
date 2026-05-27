import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { CustomerStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { CustomersController } from "../src/modules/customers/customers.controller";
import { CustomersService } from "../src/modules/customers/customers.service";
import { ListCustomersQuerySchema } from "../src/modules/customers/customers.schemas";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for CustomersController, focused on the iter-15
// ListCustomersQuerySchema contract (kickoff item 5):
//   - bogus query key → 400 (.strict() on the schema)
//   - invalid enum value → 400
//   - off-whitelist sortBy → 400
//   - take above the 200 ceiling → 400
//   - valid filter + sort + page → 200 with the documented response
//     shape { items, total, skip, take, sortBy, sortDir }
//
// Two-layer structure mirrors drivers.controller.test.ts:
//   1. Schema/pipe layer: ZodValidationPipe applied to
//      ListCustomersQuerySchema. Whether a bogus query key surfaces
//      as HTTP 400 is a property of the schema's .strict() flag plus
//      the pipe's translation to BadRequestException — exercised
//      directly below without booting an HTTP server.
//
//   2. Controller layer: CustomersController.list() / getById() called
//      against a real PrismaService + real CustomersService, with
//      AuthGuard overridden to pass-through so the test does not need
//      a better-auth session. The response shape is asserted here.

describe("CustomersController list-query schema (iter-15 contract)", () => {
  // Pipe-level tests do not need a TestingModule — the pipe and
  // schema are pure code and can be tested directly. This is the
  // cheapest way to assert "bogus query key → 400" without booting
  // Nest.
  const pipe = new ZodValidationPipe(ListCustomersQuerySchema);

  test("bogus query key (e.g. ?staus=ACTIVE) → BadRequestException (HTTP 400)", () => {
    // The schema is .strict(), so an unknown key fails parse(). The
    // pipe translates ZodError to BadRequestException. The runbook's
    // api-error-mapping table is the spec being verified here.
    expect(() => pipe.transform({ staus: "ACTIVE" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    // The csvEnum transform rejects unknown enum members with a 400.
    // CustomerStatus has only ACTIVE/INACTIVE; any other value fails.
    expect(() => pipe.transform({ status: "PENDING" })).toThrow(BadRequestException);
  });

  test("invalid sortBy column (off-whitelist) → BadRequestException", () => {
    // The whitelist is name / createdAt. Any other column (including
    // legitimate-looking `phone` or `panNumber`) returns 400. This
    // is both a schema check and an information-disclosure defense:
    // refusing to sort by `phone` prevents leaking ordering
    // information about Tier 2 PII.
    expect(() => pipe.transform({ sortBy: "phone" })).toThrow(BadRequestException);
  });

  test("sortBy=panNumber is rejected (information-disclosure defense)", () => {
    // PAN is a tax identifier (Tier 3 in our model) but it is still
    // off-whitelist for ordering. Pinned so a refactor that
    // "helpfully" widens the whitelist to all columns would fail
    // loudly. Same defense the Drivers schema applies to
    // licenseNumber.
    expect(() => pipe.transform({ sortBy: "panNumber" })).toThrow(BadRequestException);
  });

  test("sortBy=createdById is rejected (information-disclosure defense)", () => {
    // Even an internal admin-only field that exists on the row is
    // off-whitelist. Mirror of the Drivers test that pins the same
    // defense.
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
    // The transforms in customers.schemas.ts turn URL-shaped strings
    // into typed values: `skip=10` becomes the number 10;
    // `status=ACTIVE,INACTIVE` becomes the array [ACTIVE, INACTIVE].
    // Pinning this conversion catches a regression that would
    // forward strings to the service layer (where Prisma would
    // reject them silently or noisily).
    const result = pipe.transform({
      status: "ACTIVE,INACTIVE",
      sortBy: "name",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual([CustomerStatus.ACTIVE, CustomerStatus.INACTIVE]);
    expect(result.sortBy).toBe("name");
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
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });
});

describe("CustomersController.list (integration, real Prisma)", () => {
  // Full controller-level integration: a real CustomersController
  // with a real CustomersService and a real PrismaService, with
  // AuthGuard overridden to pass-through. The kickoff calls for the
  // response shape { items, total, skip, take, sortBy, sortDir } to
  // be asserted here.

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: CustomersController;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        CustomersService,
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
    controller = module.get(CustomersController);
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

  async function seedCustomer(
    overrides: {
      name?: string;
      status?: CustomerStatus;
    } = {},
  ) {
    return prisma.customer.create({
      data: {
        name: overrides.name ?? `Acme Construction ${randomUUID().slice(0, 6)}`,
        phone: "+977-9800000000",
        status: overrides.status ?? CustomerStatus.ACTIVE,
        createdById: adminId,
      },
    });
  }

  test("valid filter+sort+page returns response shape { items, total, skip, take, sortBy, sortDir }", async () => {
    // Seed two customers so total > 0 and the response has visible
    // structure.
    await seedCustomer({ name: "Acme Builders", status: CustomerStatus.ACTIVE });
    await seedCustomer({ name: "Beta Cement", status: CustomerStatus.INACTIVE });

    // Call the controller directly with a query the pipe would have
    // produced from `?status=ACTIVE&sortBy=name&sortDir=asc&skip=0
    // &take=10`. We pass typed values because the pipe's job
    // (asserted in the previous describe block) is to produce these
    // types; the controller's job (asserted here) is to consume them
    // correctly and shape the response.
    const response = await controller.list({
      status: [CustomerStatus.ACTIVE],
      sortBy: "name",
      sortDir: "asc",
      skip: 0,
      take: 10,
    });

    // Echoed-back keys: the controller mirrors the effective sort
    // and pagination in the response so the web client does not need
    // to re-parse them from the URL.
    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "name",
      sortDir: "asc",
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.name).toBe("Acme Builders");
    expect(response.items[0]?.status).toBe(CustomerStatus.ACTIVE);
  });

  test("empty query → controller applies defaults (sortBy=createdAt, sortDir=desc, skip=0, take=LIST_TAKE_DEFAULT)", async () => {
    await seedCustomer();

    const response = await controller.list({});

    // LIST_TAKE_DEFAULT is 20 per customers.service.ts; pinned here
    // so a change to that constant surfaces in the test as well as
    // in the contract.
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("response.items and response.total agree when no pagination is applied", async () => {
    // Sanity: total should equal items.length when the page contains
    // the whole result set. This protects against a regression in
    // the service's $transaction([findMany, count]) where the WHERE
    // clause differs between the two calls.
    await seedCustomer({ name: "First" });
    await seedCustomer({ name: "Second" });
    await seedCustomer({ name: "Third" });

    const response = await controller.list({
      status: [CustomerStatus.ACTIVE],
    });
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });
});

describe("CustomersController.getById (integration, real Prisma)", () => {
  // Detail-route integration: existence check + 404 mapping. Mirror
  // of the iter-6 Drivers detail tests.

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: CustomersController;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        CustomersService,
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
    controller = module.get(CustomersController);
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

  test("returns the customer when present", async () => {
    const created = await prisma.customer.create({
      data: {
        name: "Acme Construction Pvt. Ltd.",
        phone: "+977-9800000000",
        panNumber: "123456789",
        status: CustomerStatus.ACTIVE,
        createdById: adminId,
      },
    });

    const fetched = await controller.getById(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.name).toBe("Acme Construction Pvt. Ltd.");
    expect(fetched.panNumber).toBe("123456789");
    expect(fetched.status).toBe(CustomerStatus.ACTIVE);
  });

  test("unknown id → NotFoundException (HTTP 404) with the id named in the message", async () => {
    // The service returns null when findUnique misses; the controller
    // translates that into NotFoundException, which Nest's default
    // exception filter renders as HTTP 404 with the message in the
    // body. The runbook commits to "Customer {id} not found" wording;
    // we assert the id appears so a future message refactor that
    // dropped it would fail.
    try {
      await controller.getById("nonexistent-customer-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-customer-id");
    }
  });
});
