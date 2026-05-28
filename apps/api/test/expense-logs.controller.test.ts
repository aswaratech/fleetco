import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { ExpenseLogsController } from "../src/modules/expense-logs/expense-logs.controller";
import { ListExpenseLogsQuerySchema } from "../src/modules/expense-logs/expense-logs.schemas";
import { ExpenseLogsService } from "../src/modules/expense-logs/expense-logs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for ExpenseLogsController, mirror of the iter-19
// fuel-logs.controller.test.ts file. Two-layer structure:
//
//   1. Schema/pipe layer: ZodValidationPipe applied to
//      ListExpenseLogsQuerySchema. Whether a bogus query key surfaces
//      as HTTP 400 is a property of the schema's .strict() flag plus
//      the pipe's translation to BadRequestException — exercised
//      directly without booting an HTTP server.
//
//   2. Controller layer: ExpenseLogsController.list() / getById()
//      called against a real PrismaService + real ExpenseLogsService,
//      with AuthGuard overridden to pass-through. The response shape
//      { items, total, skip, take, sortBy, sortDir } is asserted here
//      per the iter-21 ticket spec.
//
// Auth-gate (real 401 without cookie) is intentionally NOT exercised
// here — auth.guard.test.ts already pins that path at the guard
// level. Mirror of every other controller test in this codebase.

describe("ExpenseLogsController list-query schema (iter-21 contract)", () => {
  const pipe = new ZodValidationPipe(ListExpenseLogsQuerySchema);

  test("bogus query key (e.g. ?vehicelId=...) → BadRequestException (HTTP 400)", () => {
    // The schema is .strict(), so an unknown key fails parse(). The
    // pipe translates ZodError to BadRequestException. The runbook's
    // api-error-mapping table is the spec being verified here.
    expect(() => pipe.transform({ vehicelId: "c1234567890" })).toThrow(BadRequestException);
  });

  test("bogus sortBy (e.g. amount) → BadRequestException", () => {
    // The whitelist is date / amountPaisa / createdAt — note
    // `amountPaisa` (the exact column name) is sortable but the
    // friendly `amount` is not, mirroring the API's wire-name discipline.
    try {
      pipe.transform({ sortBy: "amount" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message;
      expect(message.toLowerCase()).toContain("sortby");
    }
  });

  test("sortBy=notes is rejected (information-disclosure defense)", () => {
    // Pinned so a refactor that "helpfully" widens the whitelist to
    // all columns would fail loudly. Free-form notes content must
    // not be sortable. Same defense Fuel logs / Jobs / Trips apply.
    expect(() => pipe.transform({ sortBy: "notes" })).toThrow(BadRequestException);
  });

  test("sortBy=vendor is rejected (off-whitelist)", () => {
    // Pinning that vendor-name sorting is off-whitelist: vendor
    // identity ordering would leak information without serving a
    // clear operator need. Same shape as Fuel logs' sortBy=station
    // defense.
    expect(() => pipe.transform({ sortBy: "vendor" })).toThrow(BadRequestException);
  });

  test("sortBy=receiptNumber is rejected (off-whitelist)", () => {
    // Receipt number is a free-form identifier; sorting by it would
    // expose receipt-issue order, and the API is paginated by `date`
    // already. Off-whitelist by design.
    expect(() => pipe.transform({ sortBy: "receiptNumber" })).toThrow(BadRequestException);
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

  test("bogus category (e.g. BANANA) → BadRequestException", () => {
    // The category filter is an enum over the eight Prisma values.
    // Pinned so a typo in the URL surfaces as 400 rather than being
    // silently dropped. Mirror of the bogus-sortBy defense.
    expect(() => pipe.transform({ category: "BANANA" })).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (string → number, string → Date, enum → enum)", () => {
    const result = pipe.transform({
      vehicleId: "ckabc1234567890",
      category: "TOLL",
      startDate: "2026-02-01",
      endDate: "2026-02-28",
      sortBy: "amountPaisa",
      sortDir: "desc",
      skip: "10",
      take: "50",
    });
    expect(result.vehicleId).toBe("ckabc1234567890");
    expect(result.category).toBe("TOLL");
    expect(result.startDate).toBeInstanceOf(Date);
    expect(result.endDate).toBeInstanceOf(Date);
    expect(result.sortBy).toBe("amountPaisa");
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
    // asked for the default". Mirror of the Fuel logs / Jobs test.
    const result = pipe.transform({});
    expect(result.vehicleId).toBeUndefined();
    expect(result.tripId).toBeUndefined();
    expect(result.category).toBeUndefined();
    expect(result.startDate).toBeUndefined();
    expect(result.endDate).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });

  test("empty-string vehicleId is normalized to undefined (omit filter)", () => {
    // `?vehicleId=` from the URL surfaces as the empty string, which
    // we treat as "no filter" rather than "match the empty-string id"
    // (which would match zero rows). Mirror of the Fuel logs
    // normalization.
    const result = pipe.transform({ vehicleId: "" });
    expect(result.vehicleId).toBeUndefined();
  });
});

describe("ExpenseLogsController.list + getById (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: ExpenseLogsController;
  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [ExpenseLogsController],
      providers: [
        ExpenseLogsService,
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
    controller = module.get(ExpenseLogsController);
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

  async function seedExpense(
    overrides: {
      date?: Date;
      vehicleId?: string | null;
      category?:
        | "MAINTENANCE"
        | "REPAIR"
        | "TOLL"
        | "PARKING"
        | "INSURANCE"
        | "PERMIT"
        | "FINE"
        | "OTHER";
      amountPaisa?: number;
    } = {},
  ) {
    return prisma.expenseLog.create({
      data: {
        vehicleId: overrides.vehicleId === null ? null : (overrides.vehicleId ?? vehicleId),
        date: overrides.date ?? new Date("2026-02-15T08:00:00Z"),
        category: overrides.category ?? "MAINTENANCE",
        amountPaisa: overrides.amountPaisa ?? 250_000,
        createdById: adminId,
      },
    });
  }

  test("happy path: response shape { items, total, skip, take, sortBy, sortDir } with slim vehicle+trip projection", async () => {
    await seedExpense();
    await seedExpense({ date: new Date("2026-02-20T08:00:00Z") });

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
    expect(first.vehicle?.id).toBe(vehicleId);
    expect(first.vehicle?.registrationNumber).toMatch(/^BA 1 KA/);
    // Default sort puts the 2026-02-20 row first.
    expect(first.date.toISOString()).toBe("2026-02-20T08:00:00.000Z");
  });

  test("vehicle-agnostic expense (vehicleId=null) is returned with vehicle=null in the projection", async () => {
    // The iter-21 ticket explicitly allows vehicleId to be nullable
    // on an Expense (a quarterly insurance premium for the company
    // is not per-vehicle). Pinned here so a refactor that
    // accidentally NOT NULL'd the column would surface in the
    // controller test, and also so the LIST_SELECT's nullable
    // `vehicle` field stays nullable on the wire.
    await seedExpense({ vehicleId: null });

    const response = await controller.list({});
    expect(response.total).toBe(1);
    expect(response.items).toHaveLength(1);
    const row = response.items[0];
    expect(row.vehicleId).toBeNull();
    expect(row.vehicle).toBeNull();
  });

  test("empty query → controller applies defaults (sortBy=date, sortDir=desc, skip=0, take=LIST_TAKE_DEFAULT)", async () => {
    await seedExpense();

    const response = await controller.list({});

    expect(response.skip).toBe(0);
    // LIST_TAKE_DEFAULT is 20 per expense-logs.service.ts; pinned
    // here so a change to that constant surfaces in the test as well
    // as in the contract.
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
    await seedExpense();
    await seedExpense();
    await seedExpense();

    const response = await controller.list({});
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });

  test("category filter restricts results to that category", async () => {
    // Each row gets a different category — the filter should narrow
    // to exactly one. Mirrors the Fuel logs vehicleId-filter test
    // pattern with the new category-enum dimension.
    await seedExpense({ category: "MAINTENANCE" });
    await seedExpense({ category: "TOLL" });
    await seedExpense({ category: "REPAIR" });

    const response = await controller.list({ category: "TOLL" });
    expect(response.total).toBe(1);
    expect(response.items).toHaveLength(1);
    expect(response.items[0].category).toBe("TOLL");
  });

  test("getById returns the nested Vehicle + Trip detail shape on a real row", async () => {
    const row = await seedExpense();

    const detail = await controller.getById(row.id);
    expect(detail.id).toBe(row.id);
    expect(detail.vehicleId).toBe(vehicleId);
    // DETAIL_INCLUDE eager-loads the full Vehicle — pinned here so a
    // refactor that switched to LIST_SELECT on the detail endpoint
    // surfaces as a failure. Trip is nullable; for a row without a
    // tripId, the include returns null.
    expect(detail.vehicle).not.toBeNull();
    expect(detail.vehicle?.registrationNumber).toMatch(/^BA 1 KA/);
    expect(detail.trip).toBeNull();
  });

  test("getById on missing id throws NotFoundException (→ HTTP 404 via Nest's default filter)", async () => {
    // The service throws NotFoundException on findUnique null; the
    // controller is declarative. Pinned here so the contract that
    // the runbook's api-error-mapping table commits to (P2025 / null
    // → 404) survives a service-layer refactor.
    await expect(controller.getById("ckmissing0000000")).rejects.toThrow(NotFoundException);
  });
});
