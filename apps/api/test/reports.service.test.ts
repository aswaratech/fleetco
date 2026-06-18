import { Test, type TestingModule } from "@nestjs/testing";
import { TripStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { ReportsQuerySchema } from "../src/modules/reports/reports.schemas";
import {
  buildDateRange,
  formatDateUtc,
  priorEqualWindow,
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

// ───────────────────────────────────────────────────────────────────
// Per-vehicle fuel-efficiency report (Reports v2, A2). Distance comes
// from COMPLETED-trip odometer deltas (system-of-record, ADR-0003),
// attributed to the window by `endedAt`; consumption from FuelLog over
// the reporting `date`. The flag compares the window's km/L against the
// vehicle's prior-equal-length window. See the service docblock for the
// modeling decisions each test below pins.

describe("ReportsService.priorEqualWindow (baseline window math)", () => {
  // The baseline is the equal-length span immediately preceding
  // [from, to]. Exported and pinned directly so a refactor that
  // mis-computed the offset surfaces here rather than as a subtly-wrong
  // flag in the wild.

  test("28-day February window → the prior 28 days [Jan 4, Jan 31]", () => {
    const from = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
    const prior = priorEqualWindow(from, to);
    expect(prior.from.toISOString()).toBe("2026-01-04T00:00:00.000Z");
    expect(prior.to.toISOString()).toBe("2026-01-31T00:00:00.000Z");
  });

  test("single-day window (from === to) → the immediately prior day", () => {
    const day = new Date(Date.UTC(2026, 1, 15, 0, 0, 0, 0));
    const prior = priorEqualWindow(day, day);
    expect(prior.from.toISOString()).toBe("2026-02-14T00:00:00.000Z");
    expect(prior.to.toISOString()).toBe("2026-02-14T00:00:00.000Z");
  });

  test("7-day window → the prior 7 days, ending the day before `from`", () => {
    const from = new Date(Date.UTC(2026, 1, 8, 0, 0, 0, 0));
    const to = new Date(Date.UTC(2026, 1, 14, 0, 0, 0, 0));
    const prior = priorEqualWindow(from, to);
    expect(prior.from.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(prior.to.toISOString()).toBe("2026-02-07T00:00:00.000Z");
  });
});

describe("ReportsService.getPerVehicleEfficiency (real Prisma)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: ReportsService;
  let adminId: string;
  let driverId: string;

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
    // One shared driver satisfies every Trip's required driverId FK; the
    // efficiency report never reads the driver, so a single row is enough.
    driverId = (await seedDriver(prisma, adminId)).id;
  });

  // Seed a COMPLETED trip whose odometer delta is exactly `distanceKm`.
  // The absolute odometer values do not matter to the report (it sums
  // Σend − Σstart, so the base cancels across trips); only the delta
  // contributes. `endedAt` is the window-attribution column; `startedAt`
  // defaults to it but can be set earlier to exercise the endedAt rule.
  async function seedCompletedTrip(
    vehicleId: string,
    endedAt: Date,
    distanceKm: number,
    opts: { startedAt?: Date; startOdometerKm?: number } = {},
  ) {
    const startOdometerKm = opts.startOdometerKm ?? 100_000;
    return seedTrip(prisma, {
      vehicleId,
      driverId,
      createdById: adminId,
      status: TripStatus.COMPLETED,
      startedAt: opts.startedAt ?? endedAt,
      endedAt,
      startOdometerKm,
      endOdometerKm: startOdometerKm + distanceKm,
    });
  }

  // Seed a fuel log with explicit litres + total cost. pricePerLiterPaisa
  // is required by the schema but unread by the report; a constant keeps
  // the row valid without distracting from litres / total.
  async function seedFuelLog(
    vehicleId: string,
    date: Date,
    litersMl: number,
    totalCostPaisa: number,
  ) {
    return prisma.fuelLog.create({
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

  // February 2026 is the current window; its prior-equal window is
  // [Jan 4, Jan 31], so BASE_INSIDE (Jan 15) lands in the baseline.
  const FROM = new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 0));
  const TO = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
  const INSIDE = new Date(Date.UTC(2026, 1, 15, 8, 0, 0, 0));
  const BASE_INSIDE = new Date(Date.UTC(2026, 0, 15, 8, 0, 0, 0));

  test("empty window returns no rows and zero totals", async () => {
    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.from).toBe("2026-02-01");
    expect(report.to).toBe("2026-02-28");
    expect(report.rows).toHaveLength(0);
    expect(report.totals).toEqual({
      distanceKm: 0,
      litresMl: 0,
      fuelPaisa: 0,
      kmPerLitre: null,
      nprPerKm: null,
    });
  });

  test("distance is the sum of completed-trip odometer deltas; km/L and NPR/km computed at the edge", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Two completed trips: deltas 500 + 300 = 800 km.
    await seedCompletedTrip(vehicle.id, INSIDE, 500);
    await seedCompletedTrip(vehicle.id, INSIDE, 300, { startOdometerKm: 200_000 });
    // 100 L burned for Rs 15,000 (1,500,000 paisa).
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_500_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      vehicleId: vehicle.id,
      registrationNumber: vehicle.registrationNumber,
      distanceKm: 800,
      litresMl: 100_000,
      fuelPaisa: 1_500_000,
      // 800 km / 100 L = 8.00 km/L
      kmPerLitre: 8,
      // 1,500,000 paisa / 800 km = 1875 paisa/km
      nprPerKm: 1875,
      // No baseline activity → quiet (no flag).
      flag: "normal",
    });
  });

  test("NON-completed trips (PLANNED / IN_PROGRESS / CANCELLED) contribute no distance", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Only this completed trip should count (delta 500).
    await seedCompletedTrip(vehicle.id, INSIDE, 500);
    // Non-completed trips, each with odometer + endedAt set (the fixture
    // bypasses the status-field refine) — the report's COMPLETED filter
    // must exclude all three regardless of their fields.
    await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId,
      createdById: adminId,
      status: TripStatus.IN_PROGRESS,
      startedAt: INSIDE,
      endedAt: INSIDE,
      startOdometerKm: 300_000,
      endOdometerKm: 300_999,
    });
    await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId,
      createdById: adminId,
      status: TripStatus.CANCELLED,
      startedAt: INSIDE,
      endedAt: INSIDE,
      startOdometerKm: 400_000,
      endOdometerKm: 400_999,
    });
    await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId,
      createdById: adminId,
      status: TripStatus.PLANNED,
      startedAt: INSIDE,
      endedAt: INSIDE,
      startOdometerKm: 500_000,
      endOdometerKm: 500_999,
    });

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].distanceKm).toBe(500);
  });

  test("completed trips outside the window (by endedAt) contribute no distance", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedCompletedTrip(vehicle.id, INSIDE, 500);
    // Before the window AND before the baseline (Dec 2025) → ignored.
    await seedCompletedTrip(vehicle.id, new Date(Date.UTC(2025, 11, 15, 8, 0, 0, 0)), 700);
    // After the window (Mar 2026) → ignored.
    await seedCompletedTrip(vehicle.id, new Date(Date.UTC(2026, 2, 5, 8, 0, 0, 0)), 900);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].distanceKm).toBe(500);
  });

  test("a trip is attributed by endedAt, not startedAt", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Started Jan 31 (before the window), ended Feb 2 (inside) → counted.
    await seedCompletedTrip(vehicle.id, new Date(Date.UTC(2026, 1, 2, 8, 0, 0, 0)), 600, {
      startedAt: new Date(Date.UTC(2026, 0, 31, 8, 0, 0, 0)),
    });
    // Started Feb 27 (inside), ended Mar 2 (after the window) → excluded.
    await seedCompletedTrip(vehicle.id, new Date(Date.UTC(2026, 2, 2, 8, 0, 0, 0)), 900, {
      startedAt: new Date(Date.UTC(2026, 1, 27, 8, 0, 0, 0)),
    });

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    // Only the trip that ENDED inside the window counts; a startedAt
    // filter would have flipped this to 900.
    expect(report.rows[0].distanceKm).toBe(600);
  });

  test("inclusive through end of day: a trip and a fuel log late on the to-day are counted", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const atToEnd = new Date(Date.UTC(2026, 1, 28, 23, 59, 59, 999));
    await seedCompletedTrip(vehicle.id, atToEnd, 500);
    await seedFuelLog(vehicle.id, atToEnd, 50_000, 750_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].distanceKm).toBe(500);
    expect(report.rows[0].litresMl).toBe(50_000);
  });

  test("flag `degraded`: current km/L worse than baseline by more than 15%", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Baseline km/L = 1000 km / 100 L = 10.0
    await seedCompletedTrip(vehicle.id, BASE_INSIDE, 1000);
    await seedFuelLog(vehicle.id, BASE_INSIDE, 100_000, 1_000_000);
    // Current km/L = 800 km / 100 L = 8.0 → 20% worse → degraded
    await seedCompletedTrip(vehicle.id, INSIDE, 800);
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_000_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].flag).toBe("degraded");
    expect(report.rows[0].kmPerLitre).toBe(8);
  });

  test("flag `improved`: current km/L better than baseline by more than 15%", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Baseline 10.0; current 1200 km / 100 L = 12.0 → 20% better → improved
    await seedCompletedTrip(vehicle.id, BASE_INSIDE, 1000);
    await seedFuelLog(vehicle.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(vehicle.id, INSIDE, 1200);
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_000_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows[0].flag).toBe("improved");
    expect(report.rows[0].kmPerLitre).toBe(12);
  });

  test("flag `normal`: current km/L within ±15% of baseline", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Baseline 10.0; current 950 km / 100 L = 9.5 → 5% worse → normal
    await seedCompletedTrip(vehicle.id, BASE_INSIDE, 1000);
    await seedFuelLog(vehicle.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(vehicle.id, INSIDE, 950);
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_000_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows[0].flag).toBe("normal");
    expect(report.rows[0].kmPerLitre).toBe(9.5);
  });

  test("flag `normal`: current window measurable but no baseline activity (new vehicle, no badge)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // No January activity at all → no baseline to compare against.
    await seedCompletedTrip(vehicle.id, INSIDE, 500);
    await seedFuelLog(vehicle.id, INSIDE, 50_000, 750_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows[0].flag).toBe("normal");
    // The km/L is still shown — only the comparison is absent.
    expect(report.rows[0].kmPerLitre).toBe(10);
  });

  test("flag `insufficient-data`: current distance below the 50 km floor (NPR/km still computed)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedCompletedTrip(vehicle.id, INSIDE, 30);
    await seedFuelLog(vehicle.id, INSIDE, 10_000, 150_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows[0].flag).toBe("insufficient-data");
    // km/L em-dashes (null) when insufficient-data …
    expect(report.rows[0].kmPerLitre).toBeNull();
    // … but NPR/km is gated only on distance > 0, so it is still
    // computed here: 150,000 paisa / 30 km = 5000 paisa/km.
    expect(report.rows[0].nprPerKm).toBe(5000);
  });

  test("flag `insufficient-data`: completed-trip distance but zero litres", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Distance but no fuel logged in the window.
    await seedCompletedTrip(vehicle.id, INSIDE, 500);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      distanceKm: 500,
      litresMl: 0,
      kmPerLitre: null,
      // distance > 0 with zero fuel cost → 0 paisa/km (not null).
      nprPerKm: 0,
      flag: "insufficient-data",
    });
  });

  test("the 50 km insufficient-data floor is exact: 50 km is measurable, 49 km is not", async () => {
    const at50 = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0050" });
    const at49 = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0049" });
    await seedCompletedTrip(at50.id, INSIDE, 50);
    await seedFuelLog(at50.id, INSIDE, 5_000, 75_000);
    await seedCompletedTrip(at49.id, INSIDE, 49);
    await seedFuelLog(at49.id, INSIDE, 5_000, 75_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    const row50 = report.rows.find((r) => r.vehicleId === at50.id);
    const row49 = report.rows.find((r) => r.vehicleId === at49.id);
    // 50 km is NOT below the floor (`< 50` is false) → measurable.
    expect(row50?.flag).toBe("normal");
    expect(row50?.kmPerLitre).toBe(10); // 50 km / 5 L
    // 49 km IS below the floor → insufficient-data, km/L em-dashed.
    expect(row49?.flag).toBe("insufficient-data");
    expect(row49?.kmPerLitre).toBeNull();
  });

  test("the 15% deviation boundary is exact: exactly 15% worse is `normal`, not `degraded`", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Baseline 10.0; current 850 km / 100 L = 8.5 = baseline × 0.85
    // exactly. "More than 15%" is strict, so this is normal, not
    // degraded — the integer cross-multiplication makes the boundary
    // deterministic (float baseline × 0.85 would drift past 8.5).
    await seedCompletedTrip(vehicle.id, BASE_INSIDE, 1000);
    await seedFuelLog(vehicle.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(vehicle.id, INSIDE, 850);
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_000_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows[0].flag).toBe("normal");
    expect(report.rows[0].kmPerLitre).toBe(8.5);
  });

  test("the 15% deviation boundary is exact: just beyond 15% worse is `degraded`", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Baseline 10.0; current 840 km / 100 L = 8.4 < 8.5 → degraded.
    await seedCompletedTrip(vehicle.id, BASE_INSIDE, 1000);
    await seedFuelLog(vehicle.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(vehicle.id, INSIDE, 840);
    await seedFuelLog(vehicle.id, INSIDE, 100_000, 1_000_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows[0].flag).toBe("degraded");
  });

  test("the 15% deviation boundary on the up side: exactly +15% is `normal`, just beyond is `improved`", async () => {
    const atBoundary = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 1150" });
    const beyond = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 1160" });
    // Both share a baseline of 10.0 km/L.
    await seedCompletedTrip(atBoundary.id, BASE_INSIDE, 1000);
    await seedFuelLog(atBoundary.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(beyond.id, BASE_INSIDE, 1000);
    await seedFuelLog(beyond.id, BASE_INSIDE, 100_000, 1_000_000);
    // 1150 km / 100 L = 11.5 = baseline × 1.15 exactly → normal.
    await seedCompletedTrip(atBoundary.id, INSIDE, 1150);
    await seedFuelLog(atBoundary.id, INSIDE, 100_000, 1_000_000);
    // 1160 km / 100 L = 11.6 > 11.5 → improved.
    await seedCompletedTrip(beyond.id, INSIDE, 1160);
    await seedFuelLog(beyond.id, INSIDE, 100_000, 1_000_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows.find((r) => r.vehicleId === atBoundary.id)?.flag).toBe("normal");
    expect(report.rows.find((r) => r.vehicleId === beyond.id)?.flag).toBe("improved");
  });

  test("NPR/km is null when there is no completed-trip distance (fuel-only vehicle)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    // Fuel logged but no completed trips → distance 0.
    await seedFuelLog(vehicle.id, INSIDE, 50_000, 750_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      distanceKm: 0,
      litresMl: 50_000,
      kmPerLitre: null, // insufficient-data (distance below floor)
      nprPerKm: null, // no divide-by-zero
      flag: "insufficient-data",
    });
  });

  test("vehicleId filter narrows to one vehicle (current and baseline both narrowed)", async () => {
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 0002" });
    // Vehicle b also has a baseline that would change its flag — the
    // narrow must drop b's rows entirely, not just hide them.
    await seedCompletedTrip(a.id, INSIDE, 500);
    await seedFuelLog(a.id, INSIDE, 50_000, 750_000);
    await seedCompletedTrip(b.id, BASE_INSIDE, 1000);
    await seedFuelLog(b.id, BASE_INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(b.id, INSIDE, 600);
    await seedFuelLog(b.id, INSIDE, 100_000, 1_000_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO, vehicleId: a.id });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].vehicleId).toBe(a.id);
    expect(report.totals.distanceKm).toBe(500);
  });

  test("rows sort by flag priority (degraded → improved → normal → insufficient-data), then registration asc", async () => {
    // Two degraded vehicles pin the within-flag registration tiebreak;
    // the improved vehicle's registration sorts first alphabetically but
    // its flag must place it AFTER both degradeds.
    const d1 = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0001" });
    const d2 = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 0002" });
    const imp = await seedVehicle(prisma, adminId, { registrationNumber: "BA 0 KA 0000" });
    const nrm = await seedVehicle(prisma, adminId, { registrationNumber: "BA 0 KA 0001" });
    const ins = await seedVehicle(prisma, adminId, { registrationNumber: "BA 0 KA 0002" });

    // Shared baseline of 10.0 km/L for the three flagged-by-comparison
    // vehicles (d1, d2, imp). nrm is normal via no-baseline; ins is
    // insufficient-data via the distance floor.
    for (const v of [d1, d2, imp]) {
      await seedCompletedTrip(v.id, BASE_INSIDE, 1000);
      await seedFuelLog(v.id, BASE_INSIDE, 100_000, 1_000_000);
    }
    await seedCompletedTrip(d1.id, INSIDE, 800); // 8.0 → degraded
    await seedFuelLog(d1.id, INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(d2.id, INSIDE, 800); // 8.0 → degraded
    await seedFuelLog(d2.id, INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(imp.id, INSIDE, 1200); // 12.0 → improved
    await seedFuelLog(imp.id, INSIDE, 100_000, 1_000_000);
    await seedCompletedTrip(nrm.id, INSIDE, 500); // no baseline → normal
    await seedFuelLog(nrm.id, INSIDE, 50_000, 750_000);
    await seedCompletedTrip(ins.id, INSIDE, 30); // below floor → insufficient-data
    await seedFuelLog(ins.id, INSIDE, 10_000, 150_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });
    expect(report.rows.map((r) => r.vehicleId)).toEqual([d1.id, d2.id, imp.id, nrm.id, ins.id]);
    expect(report.rows.map((r) => r.flag)).toEqual([
      "degraded",
      "degraded",
      "improved",
      "normal",
      "insufficient-data",
    ]);
  });

  test("fleet totals sum the rows; fleet km/L and NPR/km are display ratios at the edge", async () => {
    const a = await seedVehicle(prisma, adminId, { registrationNumber: "BA 1 KA 7777" });
    const b = await seedVehicle(prisma, adminId, { registrationNumber: "BA 2 KA 8888" });
    await seedCompletedTrip(a.id, INSIDE, 600);
    await seedFuelLog(a.id, INSIDE, 60_000, 900_000);
    await seedCompletedTrip(b.id, INSIDE, 400);
    await seedFuelLog(b.id, INSIDE, 40_000, 600_000);

    const report = await service.getPerVehicleEfficiency({ from: FROM, to: TO });

    const sumDistance = report.rows.reduce((acc, r) => acc + r.distanceKm, 0);
    const sumLitres = report.rows.reduce((acc, r) => acc + r.litresMl, 0);
    const sumFuel = report.rows.reduce((acc, r) => acc + r.fuelPaisa, 0);
    expect(report.totals.distanceKm).toBe(sumDistance);
    expect(report.totals.litresMl).toBe(sumLitres);
    expect(report.totals.fuelPaisa).toBe(sumFuel);
    expect(sumDistance).toBe(1000);
    expect(sumLitres).toBe(100_000);
    expect(sumFuel).toBe(1_500_000);
    // Fleet km/L = 1000 km / 100 L = 10.0; NPR/km = 1,500,000 / 1000 = 1500.
    expect(report.totals.kmPerLitre).toBe(10);
    expect(report.totals.nprPerKm).toBe(1500);
  });
});
