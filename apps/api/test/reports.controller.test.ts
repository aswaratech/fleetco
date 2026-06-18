import { BadRequestException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TripStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { ReportsController } from "../src/modules/reports/reports.controller";
import { ReportsQuerySchema } from "../src/modules/reports/reports.schemas";
import { ReportsService } from "../src/modules/reports/reports.service";

import { resetDb } from "./db";
import { seedExpenseLog } from "./fixtures/expense-log";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// Controller tests for ReportsController — iter 23 (Reports v1, the
// last Phase-1 slice). Mirror of every other vertical-slice
// controller test in this codebase:
//
//   1. Schema/pipe layer: ZodValidationPipe applied to
//      ReportsQuerySchema. Whether a bogus query key surfaces as
//      HTTP 400 is a property of the schema's .strict() flag plus
//      the pipe's translation to BadRequestException — exercised
//      directly without booting an HTTP server.
//
//   2. Controller layer: ReportsController.getPerVehicleCost()
//      called against a real PrismaService + real ReportsService,
//      with AuthGuard overridden to pass-through. The full
//      { from, to, rows, totals, companyLevel } shape is asserted
//      here per the iter-23 ticket spec.
//
// Auth-gate (real 401 without cookie) is intentionally NOT exercised
// here — auth.guard.test.ts already pins that path at the guard
// level. Mirror of every other controller test in this codebase.

describe("ReportsController query schema (iter-23 contract)", () => {
  const pipe = new ZodValidationPipe(ReportsQuerySchema);

  test("missing 'from' → BadRequestException (HTTP 400)", () => {
    // The schema requires both `from` and `to`; the pipe must
    // translate the ZodError to a 400 with a field-named message.
    try {
      pipe.transform({ to: "2026-02-28" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message.toLowerCase();
      expect(message).toContain("from");
    }
  });

  test("missing 'to' → BadRequestException (HTTP 400)", () => {
    try {
      pipe.transform({ from: "2026-02-01" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message.toLowerCase();
      expect(message).toContain("to");
    }
  });

  test("invalid 'from' date format (e.g., 2026-13-40) → BadRequestException", () => {
    // The YYYY-MM-DD regex catches the pattern violation; a
    // refactor that loosened the schema to z.coerce.date() would
    // accept ISO 8601 timestamps and silently truncate them to
    // midnight — that change would surface here.
    expect(() => pipe.transform({ from: "not-a-date", to: "2026-02-28" })).toThrow(
      BadRequestException,
    );
  });

  test("invalid 'to' date format (ISO 8601 timestamp) → BadRequestException", () => {
    // ISO 8601 timestamps are deliberately rejected on this surface
    // — the cost report is calendar-day-bucketed, and accepting
    // a sub-day timestamp would mislead the operator about what
    // "to" really meant. Pinned by the YYYY-MM-DD regex.
    expect(() => pipe.transform({ from: "2026-02-01", to: "2026-02-28T15:00:00Z" })).toThrow(
      BadRequestException,
    );
  });

  test("from > to → BadRequestException with 'to'-named path", () => {
    // The cross-field refine in ReportsQuerySchema uses
    // `path: ["to"]` so the web form can highlight the right
    // input. Pinned here so a refactor that flipped the path
    // would surface.
    try {
      pipe.transform({ from: "2026-02-28", to: "2026-02-01" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message.toLowerCase();
      expect(message).toContain("to");
    }
  });

  test("invalid 'vehicleId' (not a cuid) → BadRequestException", () => {
    expect(() =>
      pipe.transform({ from: "2026-02-01", to: "2026-02-28", vehicleId: "not-a-cuid" }),
    ).toThrow(BadRequestException);
  });

  test("bogus query key (e.g. ?vehicelId=...) → BadRequestException", () => {
    // .strict() defense: a typo'd query key surfaces as 400 rather
    // than being silently ignored. Mirror of the Fuel logs /
    // Expense logs / Jobs / Trips list-query defense.
    expect(() =>
      pipe.transform({ from: "2026-02-01", to: "2026-02-28", vehicelId: "ckabc1234567890" }),
    ).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (string → Date)", () => {
    const result = pipe.transform({
      from: "2026-02-01",
      to: "2026-02-28",
      vehicleId: "ckabc1234567890",
    });
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
    expect(result.from.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(result.to.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(result.vehicleId).toBe("ckabc1234567890");
  });

  test("empty-string vehicleId is normalized to undefined (omit filter)", () => {
    // `?vehicleId=` from the URL surfaces as the empty string,
    // which we treat as "no filter" rather than "match the empty-
    // string id". Mirror of the Fuel logs / Expense logs
    // normalization.
    const result = pipe.transform({
      from: "2026-02-01",
      to: "2026-02-28",
      vehicleId: "",
    });
    expect(result.vehicleId).toBeUndefined();
  });

  test("from === to is accepted (single-day window)", () => {
    const result = pipe.transform({ from: "2026-02-15", to: "2026-02-15" });
    expect(result.from.toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(result.to.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });
});

describe("ReportsController.getPerVehicleCost (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: ReportsController;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        ReportsService,
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
    controller = module.get(ReportsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
  });

  async function seedFuelLog(vehicleId: string, date: Date, totalCostPaisa: number): Promise<void> {
    await prisma.fuelLog.create({
      data: {
        vehicleId,
        date,
        litersMl: 10_000,
        pricePerLiterPaisa: 15_000,
        totalCostPaisa,
        createdById: adminId,
      },
    });
  }

  const FROM = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
  const TO = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
  const INSIDE = new Date(Date.UTC(2026, 1, 15, 8, 0, 0, 0));

  test("integration: full response shape { from, to, rows, totals, companyLevel } is echoed", async () => {
    // The from / to fields on the response are YYYY-MM-DD strings
    // (not Date objects) so the web page can re-render its date
    // inputs from the response without re-parsing the URL. Pinned
    // here because a controller that accidentally passed the raw
    // Date objects through would still typecheck but break the
    // web client's round-trip.
    const vehicle = await seedVehicle(prisma, adminId);
    await seedFuelLog(vehicle.id, INSIDE, 100_000);

    const response = await controller.getPerVehicleCost({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });

    expect(response.from).toBe("2026-02-01");
    expect(response.to).toBe("2026-02-28");
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0]).toMatchObject({
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      fuelPaisa: 100_000,
      expensePaisa: 0,
      totalPaisa: 100_000,
      fuelLogCount: 1,
      expenseLogCount: 0,
    });
    expect(response.totals).toEqual({
      fuelPaisa: 100_000,
      expensePaisa: 0,
      totalPaisa: 100_000,
    });
    expect(response.companyLevel).toEqual({ expensePaisa: 0, expenseLogCount: 0 });
  });

  test("integration: vehicle-agnostic expense is routed to companyLevel block (rule #2)", async () => {
    // Rule #2 from iter 22 carried into the report: a vehicleId-
    // null expense is never reachable from a per-vehicle row. The
    // integration test exercises the full wire shape: the rows
    // array stays empty while the companyLevel block surfaces.
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: null,
      date: INSIDE,
      amountPaisa: 750_000,
    });

    const response = await controller.getPerVehicleCost({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });

    expect(response.rows).toHaveLength(0);
    expect(response.totals).toEqual({ fuelPaisa: 0, expensePaisa: 0, totalPaisa: 0 });
    expect(response.companyLevel).toEqual({ expensePaisa: 750_000, expenseLogCount: 1 });
  });

  test("integration: vehicleId filter narrows the rows but companyLevel stays independent", async () => {
    // Mirror of the service-level test, asserted through the
    // controller to pin the wire contract. The vehicleId filter
    // applies to per-vehicle rows; the companyLevel block is
    // independent of the filter because the operator wants the
    // context regardless of which vehicle they're inspecting.
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0002" });
    await seedFuelLog(a.id, INSIDE, 100_000);
    await seedFuelLog(b.id, INSIDE, 500_000);
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: null,
      date: INSIDE,
      amountPaisa: 80_000,
    });

    const response = await controller.getPerVehicleCost({
      from: FROM,
      to: TO,
      vehicleId: a.id,
    });

    expect(response.rows).toHaveLength(1);
    expect(response.rows[0].vehicleId).toBe(a.id);
    expect(response.totals).toEqual({
      fuelPaisa: 100_000,
      expensePaisa: 0,
      totalPaisa: 100_000,
    });
    expect(response.companyLevel.expensePaisa).toBe(80_000);
  });

  test("integration: rows array is sorted by totalPaisa desc across multiple vehicles", async () => {
    // Pinned at the controller layer so a wire-shape consumer can
    // rely on the sort order without re-sorting client-side. The
    // service-level test already pins the sort; this asserts the
    // controller does not reorder.
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 1001" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 1002" });
    const c = await seedVehicle(prisma, adminId, { registrationNumber: "BA 3 KA 1003" });
    await seedFuelLog(a.id, INSIDE, 300_000);
    await seedFuelLog(b.id, INSIDE, 100_000);
    await seedFuelLog(c.id, INSIDE, 200_000);

    const response = await controller.getPerVehicleCost({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });

    expect(response.rows.map((r) => r.totalPaisa)).toEqual([300_000, 200_000, 100_000]);
    expect(response.rows.map((r) => r.vehicleId)).toEqual([a.id, c.id, b.id]);
  });
});

// ───────────────────────────────────────────────────────────────────
// Per-vehicle fuel-efficiency route (Reports v2, A2). The route reuses
// ReportsQuerySchema VERBATIM, so its query defenses are identical to
// the cost route's; the pipe describe below re-pins a representative
// subset at the efficiency surface (a guard against a future fork of
// the schema for one route only), and the integration describe pins the
// wire shape — which differs from the cost report (no companyLevel; the
// efficiency rows carry distance / litres / km/L / NPR/km / flag).

describe("ReportsController per-vehicle-efficiency query schema (reuses ReportsQuerySchema)", () => {
  // Same schema, same pipe as the cost route — these assert the
  // efficiency surface inherits the calendar-day + .strict() + ordering
  // defenses, and would fail if someone swapped in a looser schema here.
  const pipe = new ZodValidationPipe(ReportsQuerySchema);

  test("missing 'from' → BadRequestException (HTTP 400)", () => {
    expect(() => pipe.transform({ to: "2026-02-28" })).toThrow(BadRequestException);
  });

  test("ISO 8601 timestamp for 'to' → BadRequestException (calendar-day only)", () => {
    expect(() => pipe.transform({ from: "2026-02-01", to: "2026-02-28T15:00:00Z" })).toThrow(
      BadRequestException,
    );
  });

  test("from > to → BadRequestException with 'to'-named path", () => {
    try {
      pipe.transform({ from: "2026-02-28", to: "2026-02-01" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message.toLowerCase()).toContain("to");
    }
  });

  test("bogus query key → BadRequestException (.strict)", () => {
    expect(() =>
      pipe.transform({ from: "2026-02-01", to: "2026-02-28", vehicelId: "ckabc1234567890" }),
    ).toThrow(BadRequestException);
  });

  test("invalid 'vehicleId' (not a cuid) → BadRequestException", () => {
    expect(() =>
      pipe.transform({ from: "2026-02-01", to: "2026-02-28", vehicleId: "not-a-cuid" }),
    ).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (string → Date)", () => {
    const result = pipe.transform({
      from: "2026-02-01",
      to: "2026-02-28",
      vehicleId: "ckabc1234567890",
    });
    expect(result.from).toBeInstanceOf(Date);
    expect(result.to).toBeInstanceOf(Date);
    expect(result.vehicleId).toBe("ckabc1234567890");
  });
});

describe("ReportsController.getPerVehicleEfficiency (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: ReportsController;
  let adminId: string;
  let driverId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        ReportsService,
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
    controller = module.get(ReportsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    driverId = (await seedDriver(prisma, adminId)).id;
  });

  async function seedCompletedTrip(
    vehicleId: string,
    endedAt: Date,
    distanceKm: number,
    startOdometerKm = 100_000,
  ): Promise<void> {
    await seedTrip(prisma, {
      vehicleId,
      driverId,
      createdById: adminId,
      status: TripStatus.COMPLETED,
      startedAt: endedAt,
      endedAt,
      startOdometerKm,
      endOdometerKm: startOdometerKm + distanceKm,
    });
  }

  async function seedFuelLog(
    vehicleId: string,
    date: Date,
    litersMl: number,
    totalCostPaisa: number,
  ): Promise<void> {
    await prisma.fuelLog.create({
      data: {
        vehicleId,
        date,
        litersMl,
        pricePerLiterPaisa: 15_000,
        totalCostPaisa,
        createdById: adminId,
      },
    });
  }

  const FROM = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
  const TO = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
  const INSIDE = new Date(Date.UTC(2026, 1, 15, 8, 0, 0, 0));
  const BASE_INSIDE = new Date(Date.UTC(2026, 0, 15, 8, 0, 0, 0));

  test("full response shape { from, to, rows, totals } is echoed (no companyLevel block)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedCompletedTrip(vehicle.id, INSIDE, 800);
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_500_000);

    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });

    expect(response.from).toBe("2026-02-01");
    expect(response.to).toBe("2026-02-28");
    // The cost report carries a companyLevel block; the efficiency
    // report does NOT (both inputs are always vehicle-bound).
    expect(response).not.toHaveProperty("companyLevel");
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0]).toMatchObject({
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      distanceKm: 800,
      litresMl: 100_000,
      kmPerLitre: 8,
      nprPerKm: 1875,
      fuelPaisa: 1_500_000,
      flag: "normal",
    });
    expect(response.totals).toEqual({
      distanceKm: 800,
      litresMl: 100_000,
      fuelPaisa: 1_500_000,
      kmPerLitre: 8,
      nprPerKm: 1875,
    });
  });

  test("a degraded vehicle surfaces the flag over the wire", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Baseline 10.0 km/L; current 8.0 → degraded.
    await seedCompletedTrip(vehicle.id, BASE_INSIDE, 1000);
    await seedFuelLog(vehicle.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(vehicle.id, INSIDE, 800);
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_000_000);

    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });
    expect(response.rows[0].flag).toBe("degraded");
    expect(response.rows[0].kmPerLitre).toBe(8);
  });

  test("a fuel-only vehicle is insufficient-data with null km/L and null NPR/km over the wire", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedFuelLog(vehicle.id, INSIDE, 50_000, 750_000);

    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0]).toMatchObject({
      distanceKm: 0,
      litresMl: 50_000,
      kmPerLitre: null,
      nprPerKm: null,
      flag: "insufficient-data",
    });
  });

  test("vehicleId filter narrows the rows to the named vehicle", async () => {
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0002" });
    await seedCompletedTrip(a.id, INSIDE, 500);
    await seedFuelLog(a.id, INSIDE, 50_000, 750_000);
    await seedCompletedTrip(b.id, INSIDE, 900);
    await seedFuelLog(b.id, INSIDE, 90_000, 1_350_000);

    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: a.id,
    });
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0].vehicleId).toBe(a.id);
    expect(response.totals.distanceKm).toBe(500);
  });

  test("rows are sorted by flag priority across vehicles (degraded before normal)", async () => {
    const degraded = await seedVehicle(prisma, adminId, { registrationNumber: "BA 9 KA 9999" });
    const normal = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    // degraded: baseline 10.0, current 8.0
    await seedCompletedTrip(degraded.id, BASE_INSIDE, 1000);
    await seedFuelLog(degraded.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(degraded.id, INSIDE, 800);
    await seedFuelLog(degraded.id, INSIDE, 100_000, 1_000_000);
    // normal: no baseline
    await seedCompletedTrip(normal.id, INSIDE, 500);
    await seedFuelLog(normal.id, INSIDE, 50_000, 750_000);

    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });
    // Degraded sorts first despite its registration sorting LAST — the
    // controller must not reorder the service's flag-priority sort.
    expect(response.rows.map((r) => r.vehicleId)).toEqual([degraded.id, normal.id]);
    expect(response.rows.map((r) => r.flag)).toEqual(["degraded", "normal"]);
  });

  test("empty window returns no rows and null-ratio totals", async () => {
    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });
    expect(response.rows).toHaveLength(0);
    expect(response.totals).toEqual({
      distanceKm: 0,
      litresMl: 0,
      fuelPaisa: 0,
      kmPerLitre: null,
      nprPerKm: null,
    });
  });

  test("a zero-activity vehicle does not appear (no zero-fill)", async () => {
    const active = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0123" });
    const idle = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0456" });
    await seedCompletedTrip(active.id, INSIDE, 500);
    await seedFuelLog(active.id, INSIDE, 50_000, 750_000);

    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0].vehicleId).toBe(active.id);
    expect(response.rows.find((r) => r.vehicleId === idle.id)).toBeUndefined();
  });

  test("fleet totals sum the rows and carry the edge-computed ratios over the wire", async () => {
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 7777" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 8888" });
    await seedCompletedTrip(a.id, INSIDE, 600);
    await seedFuelLog(a.id, INSIDE, 60_000, 900_000);
    await seedCompletedTrip(b.id, INSIDE, 400);
    await seedFuelLog(b.id, INSIDE, 40_000, 600_000);

    const response = await controller.getPerVehicleEfficiency({
      from: FROM,
      to: TO,
      vehicleId: undefined,
    });
    expect(response.totals).toEqual({
      distanceKm: 1000,
      litresMl: 100_000,
      fuelPaisa: 1_500_000,
      kmPerLitre: 10, // 1000 km / 100 L
      nprPerKm: 1500, // 1,500,000 paisa / 1000 km
    });
  });
});
