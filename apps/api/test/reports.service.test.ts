import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { ReportsQuerySchema } from "../src/modules/reports/reports.schemas";
import {
  buildDateRange,
  formatDateUtc,
  ReportsService,
} from "../src/modules/reports/reports.service";

import { resetDb } from "./db";
import { seedExpenseLog } from "./fixtures/expense-log";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// Service-level tests for ReportsService — iter 23 (Reports v1, the
// last Phase-1 slice). The cost report sums FuelLog.totalCostPaisa
// and ExpenseLog.amountPaisa over a date range, grouped by
// vehicleId. Tests cover the twelve cases the iter-23 ticket
// enumerates plus the helper-function invariants the schema and the
// service share.
//
// Fixtures pattern matches every prior slice's service-test suite:
// real Prisma via PrismaService inside a TestingModule, resetDb in
// beforeEach to truncate, and the existing seedUser / seedVehicle /
// seedTrip / seedDriver / seedExpenseLog helpers from
// apps/api/test/fixtures/. Fuel logs are seeded inline (the slice
// did not export a fixture helper; the seeded shape is small).
//
// The three expense-log-specific rules from iter 22 the iter-23
// ticket calls out:
//   1. `amountPaisa` is summed verbatim — no derivation.
//   2. Vehicle-agnostic expenses (vehicleId=null) go into
//      `companyLevel`, never into a per-vehicle row.
//   3. The date filter applies to the `date` column on both FuelLog
//      and ExpenseLog (the user's reporting date), not `createdAt`.
//
// Each rule has at least one dedicated test below.

describe("ReportsService.buildDateRange + formatDateUtc (date helpers)", () => {
  // The date helpers are exported so the schema and the service
  // share a single source of truth on the inclusive-through-end-
  // of-day semantic. Pinning the invariant here means a refactor
  // that drops the millisecond fudge would surface as a test
  // failure rather than as a silently-truncated row in the wild.

  test("buildDateRange returns gte=from-midnight, lte=to-midnight + 1day - 1ms", () => {
    const from = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
    const range = buildDateRange(from, to);
    expect(range.gte.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    // `to` shifted to inclusive-end-of-day: 2026-02-28T23:59:59.999Z
    expect(range.lte.toISOString()).toBe("2026-02-28T23:59:59.999Z");
  });

  test("buildDateRange with from === to spans exactly one day", () => {
    const day = new Date(Date.UTC(2026, 1, 15, 0, 0, 0, 0));
    const range = buildDateRange(day, day);
    expect(range.gte.toISOString()).toBe("2026-02-15T00:00:00.000Z");
    expect(range.lte.toISOString()).toBe("2026-02-15T23:59:59.999Z");
  });

  test("formatDateUtc echoes the YYYY-MM-DD the schema would have parsed", () => {
    const date = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
    expect(formatDateUtc(date)).toBe("2026-02-28");
  });
});

describe("ReportsQuerySchema (cross-field refine)", () => {
  test("from > to is rejected at the schema layer", () => {
    // The iter-23 ticket scopes the inversion check to the schema
    // layer; the service trusts the validated query. Pinning the
    // schema-layer rejection means a refactor that moved the check
    // into the service would surface as a failure here.
    const result = ReportsQuerySchema.safeParse({
      from: "2026-02-28",
      to: "2026-02-01",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error path names `to` (not `from`) so the web form can
      // highlight the right input — pinned here so a refactor
      // that flipped the path would surface as a test failure.
      const toIssue = result.error.issues.find((i) => i.path[0] === "to");
      expect(toIssue).toBeDefined();
    }
  });

  test("from === to is accepted (single-day window)", () => {
    const result = ReportsQuerySchema.safeParse({
      from: "2026-02-15",
      to: "2026-02-15",
    });
    expect(result.success).toBe(true);
  });
});

describe("ReportsService.getPerVehicleCost (real Prisma)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: ReportsService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [ReportsService, PrismaService],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(ReportsService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
  });

  // Helper: seed a fuel log row inline. The fuel-logs slice did not
  // ship a fixture helper (the iter-23 ticket does not require one);
  // a one-shot helper keeps the test bodies readable.
  interface SeedFuelLogParams {
    vehicleId: string;
    date: Date;
    litersMl?: number;
    pricePerLiterPaisa?: number;
    totalCostPaisa?: number;
  }
  async function seedFuelLog(params: SeedFuelLogParams) {
    const litersMl = params.litersMl ?? 10_000;
    const pricePerLiterPaisa = params.pricePerLiterPaisa ?? 15_000;
    // Mirror the iter-20 derivation rule: total = round(L * P / 1000).
    const derivedTotal = Math.round((litersMl * pricePerLiterPaisa) / 1000);
    return prisma.fuelLog.create({
      data: {
        vehicleId: params.vehicleId,
        date: params.date,
        litersMl,
        pricePerLiterPaisa,
        totalCostPaisa: params.totalCostPaisa ?? derivedTotal,
        createdById: adminId,
      },
    });
  }

  // The default window spans February 2026; the seeded dates land
  // inside the window unless a test overrides the date explicitly.
  const FROM = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
  const TO = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
  const INSIDE = new Date(Date.UTC(2026, 1, 15, 8, 0, 0, 0));

  test("empty range (no fuel logs, no expense logs in window) returns no rows and zero totals", async () => {
    const report = await service.getPerVehicleCost({ from: FROM, to: TO });
    expect(report.from).toBe("2026-02-01");
    expect(report.to).toBe("2026-02-28");
    expect(report.rows).toHaveLength(0);
    expect(report.totals).toEqual({ fuelPaisa: 0, expensePaisa: 0, totalPaisa: 0 });
    expect(report.companyLevel).toEqual({ expensePaisa: 0, expenseLogCount: 0 });
  });

  test("single vehicle with only fuel logs surfaces fuelPaisa, expensePaisa=0, expenseLogCount=0", async () => {
    // Two fuel logs sum to 200_000 paisa for the same vehicle. No
    // expense logs anywhere; expensePaisa and expenseLogCount must
    // both be zero on the only row.
    const vehicle = await seedVehicle(prisma, adminId);
    await seedFuelLog({ vehicleId: vehicle.id, date: INSIDE, totalCostPaisa: 120_000 });
    await seedFuelLog({ vehicleId: vehicle.id, date: INSIDE, totalCostPaisa: 80_000 });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      fuelPaisa: 200_000,
      expensePaisa: 0,
      totalPaisa: 200_000,
      fuelLogCount: 2,
      expenseLogCount: 0,
    });
    expect(report.totals).toEqual({ fuelPaisa: 200_000, expensePaisa: 0, totalPaisa: 200_000 });
  });

  test("single vehicle with only expense logs surfaces expensePaisa, fuelPaisa=0, fuelLogCount=0", async () => {
    // Mirror of the prior test rotated 90° around the FuelLog /
    // ExpenseLog axis. Rule #1 from iter 22 carried into the
    // report: amountPaisa is summed verbatim (no derivation).
    const vehicle = await seedVehicle(prisma, adminId);
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: INSIDE,
      amountPaisa: 50_000,
    });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: INSIDE,
      amountPaisa: 75_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      fuelPaisa: 0,
      expensePaisa: 125_000,
      totalPaisa: 125_000,
      fuelLogCount: 0,
      expenseLogCount: 2,
    });
  });

  test("single vehicle with both fuel and expense logs sums into a single merged row", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedFuelLog({ vehicleId: vehicle.id, date: INSIDE, totalCostPaisa: 100_000 });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: INSIDE,
      amountPaisa: 60_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      vehicleId: vehicle.id,
      fuelPaisa: 100_000,
      expensePaisa: 60_000,
      totalPaisa: 160_000,
      fuelLogCount: 1,
      expenseLogCount: 1,
    });
  });

  test("multiple vehicles with mixed activity sort by totalPaisa desc", async () => {
    // Three vehicles, three totals: A (highest), B (middle), C
    // (lowest). The sort must rank them descending regardless of
    // the seed insertion order.
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0002" });
    const c = await seedVehicle(prisma, adminId, { registrationNumber: "BA 3 KA 0003" });

    // Seed in the order C, A, B to confirm the sort doesn't rely
    // on insertion order.
    await seedFuelLog({ vehicleId: c.id, date: INSIDE, totalCostPaisa: 10_000 });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: c.id,
      date: INSIDE,
      amountPaisa: 20_000,
    });
    await seedFuelLog({ vehicleId: a.id, date: INSIDE, totalCostPaisa: 500_000 });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: a.id,
      date: INSIDE,
      amountPaisa: 100_000,
    });
    await seedFuelLog({ vehicleId: b.id, date: INSIDE, totalCostPaisa: 200_000 });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(3);
    expect(report.rows.map((r) => r.vehicleId)).toEqual([a.id, b.id, c.id]);
    expect(report.rows[0].totalPaisa).toBe(600_000); // A
    expect(report.rows[1].totalPaisa).toBe(200_000); // B
    expect(report.rows[2].totalPaisa).toBe(30_000); // C
  });

  test("vehicle-agnostic expense (vehicleId=null) routes to companyLevel and NOT into per-vehicle rows", async () => {
    // Rule #2 from iter 22 carried into the report: a
    // vehicleId-null expense is never reachable from a per-vehicle
    // row. Pinned by seeding one company-level expense and zero
    // per-vehicle activity; the rows array must be empty while the
    // companyLevel block surfaces the sum.
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: null,
      date: INSIDE,
      amountPaisa: 5_000_000,
    });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: null,
      date: INSIDE,
      amountPaisa: 1_000_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(0);
    expect(report.totals).toEqual({ fuelPaisa: 0, expensePaisa: 0, totalPaisa: 0 });
    expect(report.companyLevel).toEqual({ expensePaisa: 6_000_000, expenseLogCount: 2 });
  });

  test("vehicleId filter narrows per-vehicle rows but leaves companyLevel intact", async () => {
    // Two vehicles + one company-level expense. The filter narrows
    // the rows to one vehicle's bucket; the company-level block
    // stays the same because vehicle-agnostic expenses don't
    // belong to any one vehicle and the operator wants the
    // context regardless of which vehicle they're inspecting.
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 1111" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 2222" });
    await seedFuelLog({ vehicleId: a.id, date: INSIDE, totalCostPaisa: 100_000 });
    await seedFuelLog({ vehicleId: b.id, date: INSIDE, totalCostPaisa: 200_000 });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: null,
      date: INSIDE,
      amountPaisa: 999_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO, vehicleId: a.id });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].vehicleId).toBe(a.id);
    expect(report.rows[0].fuelPaisa).toBe(100_000);
    // Company-level block is independent of the vehicleId filter.
    expect(report.companyLevel.expensePaisa).toBe(999_000);
  });

  test("inclusive 'from' boundary — a log dated exactly at from-midnight is INSIDE the window", async () => {
    // Rule #3 from iter 22 carried into the report: the date
    // filter is on `date`, not `createdAt`, and the bounds are
    // inclusive on both sides. Seed a log at exactly from-midnight
    // UTC; the row must be counted.
    const vehicle = await seedVehicle(prisma, adminId);
    const atFrom = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: atFrom,
      amountPaisa: 10_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].expensePaisa).toBe(10_000);
  });

  test("inclusive 'to' boundary — a log dated late on the to-day is INSIDE the window", async () => {
    // Pinned by seeding a row at 23:59:59.999Z on the to-day; the
    // service's buildDateRange shifts `to` to that exact moment,
    // so the row must be counted. This pins the
    // one-millisecond-before-midnight invariant in buildDateRange.
    const vehicle = await seedVehicle(prisma, adminId);
    const atToEnd = new Date(Date.UTC(2026, 1, 28, 23, 59, 59, 999));
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: atToEnd,
      amountPaisa: 25_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].expensePaisa).toBe(25_000);
  });

  test("exclusive bounds outside window — logs before 'from' or after 'to' are NOT counted", async () => {
    // Two rows outside the window (one day before, one day after)
    // and one row inside. Only the inside row is counted; the
    // outside rows fail the WHERE clause's gte/lte test.
    const vehicle = await seedVehicle(prisma, adminId);
    const before = new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999));
    const after = new Date(Date.UTC(2026, 2, 1, 0, 0, 0, 0));
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: before,
      amountPaisa: 100_000,
    });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: after,
      amountPaisa: 200_000,
    });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: INSIDE,
      amountPaisa: 50_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].expensePaisa).toBe(50_000);
    expect(report.rows[0].expenseLogCount).toBe(1);
  });

  test("date filter applies to the 'date' column, NOT createdAt (rule #3)", async () => {
    // Seed a row whose `date` is OUTSIDE the window but whose
    // `createdAt` is INSIDE (createdAt always equals "now" at insert
    // time). The row must not be counted — a refactor that swapped
    // the filter to createdAt would surface here.
    const vehicle = await seedVehicle(prisma, adminId);
    const outsideDate = new Date(Date.UTC(2025, 11, 15, 0, 0, 0, 0)); // 2025-12-15
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      date: outsideDate,
      amountPaisa: 999_999,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(0);
    expect(report.totals.totalPaisa).toBe(0);
  });

  test("totals match row sums (sanity invariant)", async () => {
    // Two vehicles, mixed activity. The totals block must equal
    // the row sums bit-for-bit — pinning this guards against a
    // future refactor that accidentally double-counted or
    // double-discounted a row.
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 7777" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 8888" });
    await seedFuelLog({ vehicleId: a.id, date: INSIDE, totalCostPaisa: 100_000 });
    await seedFuelLog({ vehicleId: b.id, date: INSIDE, totalCostPaisa: 250_000 });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: a.id,
      date: INSIDE,
      amountPaisa: 30_000,
    });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: b.id,
      date: INSIDE,
      amountPaisa: 70_000,
    });
    // Plus a company-level expense — the totals block must NOT
    // include it (the page surfaces it separately).
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: null,
      date: INSIDE,
      amountPaisa: 1_000_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    const sumFuel = report.rows.reduce((acc, r) => acc + r.fuelPaisa, 0);
    const sumExpense = report.rows.reduce((acc, r) => acc + r.expensePaisa, 0);
    const sumTotal = report.rows.reduce((acc, r) => acc + r.totalPaisa, 0);
    expect(report.totals.fuelPaisa).toBe(sumFuel);
    expect(report.totals.expensePaisa).toBe(sumExpense);
    expect(report.totals.totalPaisa).toBe(sumTotal);
    expect(sumFuel).toBe(350_000);
    expect(sumExpense).toBe(100_000);
    expect(sumTotal).toBe(450_000);
    // Company-level expense excluded from totals; surfaced
    // separately.
    expect(report.companyLevel.expensePaisa).toBe(1_000_000);
  });

  test("zero-activity vehicles are absent from the rows array (not zero-filled)", async () => {
    // The iter-23 ticket explicitly says a vehicle with zero
    // activity in the window does NOT appear. Pinning by seeding
    // two vehicles where only one has activity; the other must
    // not surface as a zero-filled row.
    const active = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0123" });
    const idle = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0456" });
    await seedFuelLog({ vehicleId: active.id, date: INSIDE, totalCostPaisa: 100_000 });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].vehicleId).toBe(active.id);
    expect(report.rows.find((r) => r.vehicleId === idle.id)).toBeUndefined();
  });

  test("fuel and expense logs paired with a trip still sum into the per-vehicle row", async () => {
    // Defensive: a tripId on the source row is metadata; the
    // vehicleId is what drives the per-vehicle bucket. The trip
    // pairing must NOT change the row's contribution to the cost
    // report — the operator sees the same total whether the
    // expense was paired with a trip or not.
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId);
    const trip = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
    });
    await seedFuelLog({ vehicleId: vehicle.id, date: INSIDE, totalCostPaisa: 80_000 });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      tripId: trip.id,
      date: INSIDE,
      amountPaisa: 20_000,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].fuelPaisa).toBe(80_000);
    expect(report.rows[0].expensePaisa).toBe(20_000);
    expect(report.rows[0].totalPaisa).toBe(100_000);
  });

  test("tie-breaker on totalPaisa: registrationNumber asc keeps order stable", async () => {
    // Two vehicles with the same totalPaisa — the tiebreaker must
    // place the lower-sorting registration first so the operator's
    // eye doesn't jump on every refresh.
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0002" });
    await seedFuelLog({ vehicleId: a.id, date: INSIDE, totalCostPaisa: 100_000 });
    await seedFuelLog({ vehicleId: b.id, date: INSIDE, totalCostPaisa: 100_000 });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(2);
    expect(report.rows[0].registrationNumber).toBe("BA 1 KA 0001");
    expect(report.rows[1].registrationNumber).toBe("BA 2 KA 0002");
  });

  test("vehicleId filter narrows to a single vehicle (other vehicles excluded)", async () => {
    // Two vehicles with similar activity; the filter must surface
    // only the named vehicle's row. The other vehicle's rows are
    // counted in NEITHER the rows array nor the totals block.
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0002" });
    await seedFuelLog({ vehicleId: a.id, date: INSIDE, totalCostPaisa: 100_000 });
    await seedFuelLog({ vehicleId: b.id, date: INSIDE, totalCostPaisa: 999_999 });
    await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: b.id,
      date: INSIDE,
      amountPaisa: 999_999,
    });

    const report = await service.getPerVehicleCost({ from: FROM, to: TO, vehicleId: a.id });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].vehicleId).toBe(a.id);
    expect(report.totals).toEqual({ fuelPaisa: 100_000, expensePaisa: 0, totalPaisa: 100_000 });
  });
});
