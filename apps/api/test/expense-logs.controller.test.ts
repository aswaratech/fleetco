import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { ExpenseLogsController } from "../src/modules/expense-logs/expense-logs.controller";
import {
  CreateExpenseLogSchema,
  ListExpenseLogsQuerySchema,
  UpdateExpenseLogSchema,
} from "../src/modules/expense-logs/expense-logs.schemas";
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

// ----------------------------------------------------------------
// iter-22: write-path schema (pipe) tests
// ----------------------------------------------------------------
// Pure pipe-level tests of CreateExpenseLogSchema / UpdateExpenseLogSchema.
// Cheap — no TestingModule. Mirror of the iter-20 Fuel logs write-schema
// pipe block, with the three expense-log-specific rules pinned:
//   1. amountPaisa is authoritative (no derivation, no rejection of a
//      client-sent value beyond bounds).
//   2. vehicleId is OPTIONAL+NULLABLE on Create (vehicle-agnostic expenses
//      such as a quarterly insurance premium are first-class).
//   3. vehicleId is IMMUTABLE on Update — the PATCH schema omits the
//      field; .strict() turns a client-sent vehicleId into HTTP 400.

describe("Expense-logs write-path schemas (iter-22 contract, pipe layer)", () => {
  const createPipe = new ZodValidationPipe(CreateExpenseLogSchema);
  const updatePipe = new ZodValidationPipe(UpdateExpenseLogSchema);

  const validCreateBody = {
    vehicleId: "ckabc1234567890",
    date: "2026-02-15",
    category: "MAINTENANCE",
    amountPaisa: 250_000,
  };

  test("CreateExpenseLogSchema: valid minimal body parses (date coerced to Date)", () => {
    const parsed = createPipe.transform({ ...validCreateBody });
    expect(parsed.vehicleId).toBe("ckabc1234567890");
    expect(parsed.category).toBe("MAINTENANCE");
    expect(parsed.amountPaisa).toBe(250_000);
    expect(parsed.date).toBeInstanceOf(Date);
    // Optional fields absent → service applies null at the column.
    expect(parsed.tripId).toBeUndefined();
    expect(parsed.vendor).toBeUndefined();
    expect(parsed.receiptNumber).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  test("CreateExpenseLogSchema: vehicle-agnostic expense (vehicleId omitted) parses", () => {
    // Iter-22 rule #2: vehicleId is optional on Create. A quarterly
    // insurance premium for the whole company is a real first-class
    // expense without a vehicle. Pinned here so a refactor that
    // tightened the schema (made vehicleId required) surfaces in the
    // pipe-level test as well as the service-level test.
    const parsed = createPipe.transform({
      date: "2026-02-15",
      category: "INSURANCE",
      amountPaisa: 5_000_000,
    });
    expect(parsed.vehicleId).toBeUndefined();
  });

  test("CreateExpenseLogSchema: vehicle-agnostic expense (vehicleId=null) parses", () => {
    // The same intent expressed as an explicit null. The web form sends
    // null when the operator clears the picker, vs. simply omitting
    // the field on a new form. Both must parse.
    const parsed = createPipe.transform({
      vehicleId: null,
      date: "2026-02-15",
      category: "INSURANCE",
      amountPaisa: 5_000_000,
    });
    expect(parsed.vehicleId).toBeNull();
  });

  test("CreateExpenseLogSchema: server-controlled createdById is rejected (.strict())", () => {
    // Same rule every other write surface enforces. The controller
    // pulls createdById from request.session per ADR-0021.
    expect(() => createPipe.transform({ ...validCreateBody, createdById: "user_x" })).toThrow(
      BadRequestException,
    );
  });

  test("CreateExpenseLogSchema: missing required date → 400", () => {
    expect(() =>
      createPipe.transform({
        vehicleId: "ckabc1234567890",
        category: "MAINTENANCE",
        amountPaisa: 250_000,
      }),
    ).toThrow(BadRequestException);
  });

  test("CreateExpenseLogSchema: missing required category → 400", () => {
    expect(() =>
      createPipe.transform({
        vehicleId: "ckabc1234567890",
        date: "2026-02-15",
        amountPaisa: 250_000,
      }),
    ).toThrow(BadRequestException);
  });

  test("CreateExpenseLogSchema: missing required amountPaisa → 400", () => {
    expect(() =>
      createPipe.transform({
        vehicleId: "ckabc1234567890",
        date: "2026-02-15",
        category: "MAINTENANCE",
      }),
    ).toThrow(BadRequestException);
  });

  test("CreateExpenseLogSchema: amountPaisa below the floor (0) → 400", () => {
    // AMOUNT_PAISA_MIN is 1: a zero-amount expense is a corrupted
    // record — the operator either meant to skip the entry or made
    // a typo. The floor catches both.
    expect(() => createPipe.transform({ ...validCreateBody, amountPaisa: 0 })).toThrow(
      BadRequestException,
    );
  });

  test("CreateExpenseLogSchema: amountPaisa above the ceiling → 400", () => {
    // AMOUNT_PAISA_MAX is 10_000_000_000 (NPR 100,000,000.00). The
    // ceiling defends against an extra-zero typo on a high-value
    // entry (e.g. an INSURANCE premium).
    expect(() => createPipe.transform({ ...validCreateBody, amountPaisa: 99_999_999_999 })).toThrow(
      BadRequestException,
    );
  });

  test("CreateExpenseLogSchema: invalid category (e.g. BANANA) → 400", () => {
    // The category enum is closed over the eight Prisma values. A
    // typo at the URL or form layer surfaces as a 400, not a silent
    // dropped field.
    expect(() => createPipe.transform({ ...validCreateBody, category: "BANANA" })).toThrow(
      BadRequestException,
    );
  });

  test("CreateExpenseLogSchema: invalid vehicleId shape (non-cuid) → 400", () => {
    expect(() => createPipe.transform({ ...validCreateBody, vehicleId: "not-a-cuid" })).toThrow(
      BadRequestException,
    );
  });

  test("UpdateExpenseLogSchema: empty body → 400 (at-least-one-field refine)", () => {
    expect(() => updatePipe.transform({})).toThrow(BadRequestException);
  });

  test("UpdateExpenseLogSchema: vehicleId is rejected (immutable on PATCH)", () => {
    // Iter-22 rule #3: the PATCH schema deliberately omits vehicleId
    // from its shape; .strict() turns that into a 400 rather than
    // silently dropping the field. This is the core immutability
    // contract — pinning vehicle-binding-after-create is a strict
    // boundary so a misconfigured form action surfaces as an
    // inline error.
    expect(() => updatePipe.transform({ vehicleId: "ckabc1234567890" })).toThrow(
      BadRequestException,
    );
  });

  test("UpdateExpenseLogSchema: createdById is rejected (.strict())", () => {
    // Server-controlled, identical defense to Create. A client trying
    // to re-attribute an existing expense to a different user is a
    // bug, not a feature.
    expect(() => updatePipe.transform({ createdById: "user_x" })).toThrow(BadRequestException);
  });

  test("UpdateExpenseLogSchema: single-field amountPaisa patch parses", () => {
    // amountPaisa is mutable on PATCH (an operator might fix a
    // mis-keyed entry after seeing the receipt). The single-field
    // patch must parse so the diff-PATCH service code can apply it.
    const parsed = updatePipe.transform({ amountPaisa: 300_000 });
    expect(parsed.amountPaisa).toBe(300_000);
  });

  test("UpdateExpenseLogSchema: single-field tripId patch parses (mutable on PATCH)", () => {
    const parsed = updatePipe.transform({ tripId: "ckabcdef12345678" });
    expect(parsed.tripId).toBe("ckabcdef12345678");
  });

  test("UpdateExpenseLogSchema: tripId = null parses (unpair semantics)", () => {
    // The web form sends null when the operator clears the picker.
    // The service interprets null as "set the column to null" via
    // the diff-PATCH `has()` helper.
    const parsed = updatePipe.transform({ tripId: null });
    expect(parsed.tripId).toBeNull();
  });

  test("UpdateExpenseLogSchema: bogus key is rejected (.strict())", () => {
    expect(() => updatePipe.transform({ amount: 100_000 })).toThrow(BadRequestException);
  });

  test("UpdateExpenseLogSchema: amountPaisa above the ceiling on PATCH → 400", () => {
    // The bounds apply on PATCH too — an extra-zero typo when
    // correcting a value should still be caught.
    expect(() => updatePipe.transform({ amountPaisa: 99_999_999_999 })).toThrow(
      BadRequestException,
    );
  });
});

// ----------------------------------------------------------------
// iter-22: controller create / update / remove (integration)
// ----------------------------------------------------------------
// Full controller-level integration for the write path: real
// ExpenseLogsController + ExpenseLogsService + PrismaService, AuthGuard
// overridden, AUTH stubbed. The controller's create() reads
// createdById from request.session.user.id; we hand it a minimal
// fake request cast — same approach the iter-20 Fuel logs / Jobs /
// Customers controller tests take.

describe("ExpenseLogsController.create / update / remove (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: ExpenseLogsController;
  let adminId: string;
  let vehicleAId: string;
  let vehicleBId: string;
  let tripId: string;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [ExpenseLogsController],
      providers: [
        ExpenseLogsService,
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
    controller = module.get(ExpenseLogsController);
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

  test("create() persists with amountPaisa stored as-given and createdById from session", async () => {
    // Iter-22 rule #1: amountPaisa is authoritative — no derivation.
    // Pinned by asserting the value round-trips verbatim from the
    // body to the stored row.
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        category: "MAINTENANCE",
        amountPaisa: 250_000,
        vendor: "Sundar Workshop",
      },
      fakeRequest,
    );
    expect(created.amountPaisa).toBe(250_000);
    expect(created.createdById).toBe(adminId);
    expect(created.vehicle?.id).toBe(vehicleAId);
    expect(created.vendor).toBe("Sundar Workshop");
  });

  test("create() vehicle-agnostic (vehicleId omitted) persists with vehicle=null in the detail", async () => {
    // Iter-22 rule #2: a quarterly insurance premium for the whole
    // company is a first-class expense with no vehicle. The detail
    // response must expose vehicle as null (DETAIL_INCLUDE is the
    // full nullable Vehicle relation).
    const created = await controller.create(
      {
        date: new Date("2026-02-15T08:00:00Z"),
        category: "INSURANCE",
        amountPaisa: 5_000_000,
        vendor: "Sagarmatha Insurance",
      },
      fakeRequest,
    );
    expect(created.vehicleId).toBeNull();
    expect(created.vehicle).toBeNull();
    expect(created.category).toBe("INSURANCE");
    expect(created.amountPaisa).toBe(5_000_000);
  });

  test("create() with tripId paired to its vehicle returns the nested trip", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        tripId,
        date: new Date("2026-02-15T08:00:00Z"),
        category: "TOLL",
        amountPaisa: 12_500,
      },
      fakeRequest,
    );
    expect(created.trip?.id).toBe(tripId);
    expect(created.amountPaisa).toBe(12_500);
  });

  test("create() with a trip-vehicle mismatch → BadRequestException (HTTP 400)", async () => {
    // The trip is bound to vehicleAId; passing vehicleBId triggers
    // the consistency check the same way Fuel logs iter-20 enforces.
    try {
      await controller.create(
        {
          vehicleId: vehicleBId,
          tripId,
          date: new Date("2026-02-15T08:00:00Z"),
          category: "TOLL",
          amountPaisa: 12_500,
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
          category: "MAINTENANCE",
          amountPaisa: 250_000,
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

  test("update() applies a diff-PATCH (vendor only) and leaves amountPaisa untouched", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        category: "MAINTENANCE",
        amountPaisa: 250_000,
        vendor: "Sundar Workshop",
      },
      fakeRequest,
    );
    const updated = await controller.update(created.id, { vendor: "Himal Workshop" });
    expect(updated.vendor).toBe("Himal Workshop");
    expect(updated.amountPaisa).toBe(created.amountPaisa);
    expect(updated.category).toBe(created.category);
  });

  test("update() applies a diff-PATCH on amountPaisa as the authoritative value", async () => {
    // Iter-22 rule #1: amountPaisa is mutable on PATCH and the
    // service writes it through verbatim. No derivation, no preview.
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        category: "MAINTENANCE",
        amountPaisa: 250_000,
      },
      fakeRequest,
    );
    const updated = await controller.update(created.id, { amountPaisa: 300_000 });
    expect(updated.amountPaisa).toBe(300_000);
  });

  test("update() unknown id → NotFoundException (HTTP 404)", async () => {
    try {
      await controller.update("ckmissingexpense12345678", { vendor: "anything" });
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("ckmissingexpense12345678");
    }
  });

  test("remove() hard-deletes and resolves without a body; 404 on unknown id", async () => {
    const created = await controller.create(
      {
        vehicleId: vehicleAId,
        date: new Date("2026-02-15T08:00:00Z"),
        category: "TOLL",
        amountPaisa: 12_500,
      },
      fakeRequest,
    );
    const result = await controller.remove(created.id);
    expect(result).toBeUndefined();
    const refetched = await prisma.expenseLog.findUnique({ where: { id: created.id } });
    expect(refetched).toBeNull();

    try {
      await controller.remove("ckmissingexpense12345678");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
    }
  });
});
