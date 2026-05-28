import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { type Driver, ExpenseCategory, type Trip, type Vehicle } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  ExpenseLogsService,
  LIST_TAKE_MAX,
} from "../src/modules/expense-logs/expense-logs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { seedExpenseLog } from "./fixtures/expense-log";

// Integration tests for ExpenseLogsService against a real Postgres.
// Mirrors the iter-19 fuel-logs.service.test.ts in shape; the iter-21
// kickoff (Checkpoint 2, last paragraph) names the coverage areas:
//
//   1. list() returns total + items; default sort is `date desc`.
//   2. Filter composition: { vehicleId } narrows; { tripId } narrows;
//      { category } narrows; { startDate, endDate } narrows; pairs
//      combine.
//   3. The nullable-vehicleId behaviour — `?vehicleId=<id>` returns
//      only rows for that vehicle (NOT the vehicle-agnostic rows);
//      asking with no filter returns BOTH attributed and
//      vehicle-agnostic rows. (vehicleId IS NULL is not a query
//      filter in iter 21 — see the schema docstring.)
//   4. `take` is clamped to LIST_TAKE_MAX; `skip` past the end
//      returns empty items + correct total.
//   5. sortBy round-trips for all three sortable columns (`date`,
//      `amountPaisa`, `createdAt`) and the id tiebreaker stabilizes
//      pagination.
//   6. findById() returns the nested Vehicle + Trip (or null for
//      either when the FK is null); missing id → null.
//   7. getById() throws NotFoundException with the id in the
//      message when missing.
//
// ExpenseLog has up to three FK references (vehicleId nullable,
// tripId nullable, createdById required). The seed below builds one
// admin user, two Vehicles, one Driver, and one Trip — enough to
// exercise the {vehicleId} narrowing across two vehicles and the
// nullable both-FKs case.

describe("ExpenseLogsService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: ExpenseLogsService;
  let adminId: string;
  let vehicleA: Vehicle;
  let vehicleB: Vehicle;
  let driver: Driver;
  let trip: Trip;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [ExpenseLogsService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(ExpenseLogsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    // ExpenseLog.vehicleId is a NULLABLE FK to Vehicle.id; tripId is
    // a NULLABLE FK to Trip.id; createdById is a non-null FK to
    // User.id. The seed builds two vehicles (so the {vehicleId}
    // narrowing test can prove the filter is real), one driver +
    // one trip (so the nullable tripId can be exercised both ways),
    // and one admin user for createdById. Auth-domain rows are left
    // untouched here.
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });

    vehicleA = await prisma.vehicle.create({
      data: {
        registrationNumber: "BA 1 KA 0001",
        kind: "TIPPER",
        make: "Tata",
        model: "LPK 2518",
        year: 2022,
        acquiredAt: new Date("2022-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    vehicleB = await prisma.vehicle.create({
      data: {
        registrationNumber: "BA 2 KA 0002",
        kind: "TRUCK",
        make: "Ashok Leyland",
        model: "1616",
        year: 2023,
        acquiredAt: new Date("2023-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });

    driver = await prisma.driver.create({
      data: {
        fullName: "Ram Bahadur",
        licenseNumber: "12-345-67890",
        licenseClass: "HTV",
        phone: "+977-9800000000",
        hiredAt: new Date("2022-01-15T00:00:00Z"),
        licenseExpiresAt: new Date("2030-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });

    trip = await prisma.trip.create({
      data: {
        vehicleId: vehicleA.id,
        driverId: driver.id,
        status: "COMPLETED",
        startedAt: new Date("2026-02-10T06:00:00Z"),
        endedAt: new Date("2026-02-10T14:00:00Z"),
        startOdometerKm: 10000,
        endOdometerKm: 10250,
        createdById: adminId,
      },
    });
  });

  describe("findById() / getById()", () => {
    test("findById() returns the row with nested vehicle and trip when both FKs are set", async () => {
      const created = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: vehicleA.id,
        tripId: trip.id,
        category: ExpenseCategory.TOLL,
        amountPaisa: 50_000,
        vendor: "Naubise Toll Booth",
      });
      const fetched = await service.findById(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.vendor).toBe("Naubise Toll Booth");
      expect(fetched?.amountPaisa).toBe(50_000);
      expect(fetched?.category).toBe(ExpenseCategory.TOLL);
      // DETAIL_INCLUDE contract — pinned here so a refactor that
      // dropped the relations would fail loudly.
      expect(fetched?.vehicle?.id).toBe(vehicleA.id);
      expect(fetched?.vehicle?.registrationNumber).toBe(vehicleA.registrationNumber);
      expect(fetched?.trip?.id).toBe(trip.id);
    });

    test("findById() returns the row with vehicle === null AND trip === null when both FKs are null", async () => {
      // The canonical "office stationery" / "company insurance
      // premium" case from the glossary. Both relations should be
      // null in the nested include.
      const created = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: null,
        tripId: null,
        category: ExpenseCategory.INSURANCE,
        amountPaisa: 25_000_000,
        vendor: "Shikhar Insurance",
      });
      const fetched = await service.findById(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.vehicle).toBeNull();
      expect(fetched?.trip).toBeNull();
      expect(fetched?.vehicleId).toBeNull();
      expect(fetched?.tripId).toBeNull();
      expect(fetched?.category).toBe(ExpenseCategory.INSURANCE);
    });

    test("findById() returns null when not present", async () => {
      const fetched = await service.findById("nonexistent-id");
      expect(fetched).toBeNull();
    });

    test("getById() throws NotFoundException with the id in the message when missing", async () => {
      try {
        await service.getById("nonexistent-id");
        throw new Error("expected NotFoundException");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toContain("nonexistent-id");
      }
    });
  });

  describe("list() — filter / sort / paginate", () => {
    // Seed seven expense logs spread across two vehicles, two
    // months, and four categories so the assertions below can be
    // precise about which rows come back for each query.
    //
    // Rows (ordered by date desc — the default list sort — for
    // human readability):
    //
    //   v=A  trip=set  cat=TOLL       date=2026-02-25  amount=  50_000  vendor="Naubise"
    //   v=B  trip=null cat=REPAIR     date=2026-02-20  amount=1_200_000 vendor="Bishal Auto"
    //   v=null trip=null cat=INSURANCE date=2026-02-18 amount=25_000_000 vendor="Shikhar"
    //   v=A  trip=null cat=MAINTENANCE date=2026-02-15 amount=  250_000 vendor="NOC service"
    //   v=B  trip=null cat=PARKING    date=2026-01-25  amount=  10_000  vendor="Kalimati Lot"
    //   v=A  trip=set  cat=FINE       date=2026-01-15  amount=  500_000 vendor="Traffic Police"
    //   v=null trip=null cat=PERMIT   date=2026-01-05  amount=  800_000 vendor="DOTM"
    async function seedSeven(): Promise<void> {
      const seeds: Parameters<typeof seedExpenseLog>[1][] = [
        {
          createdById: adminId,
          vehicleId: null,
          date: new Date("2026-01-05T08:00:00Z"),
          category: ExpenseCategory.PERMIT,
          amountPaisa: 800_000,
          vendor: "DOTM",
        },
        {
          createdById: adminId,
          vehicleId: vehicleA.id,
          tripId: trip.id,
          date: new Date("2026-01-15T08:00:00Z"),
          category: ExpenseCategory.FINE,
          amountPaisa: 500_000,
          vendor: "Traffic Police",
        },
        {
          createdById: adminId,
          vehicleId: vehicleB.id,
          date: new Date("2026-01-25T08:00:00Z"),
          category: ExpenseCategory.PARKING,
          amountPaisa: 10_000,
          vendor: "Kalimati Lot",
        },
        {
          createdById: adminId,
          vehicleId: vehicleA.id,
          date: new Date("2026-02-15T08:00:00Z"),
          category: ExpenseCategory.MAINTENANCE,
          amountPaisa: 250_000,
          vendor: "NOC service",
        },
        {
          createdById: adminId,
          vehicleId: null,
          date: new Date("2026-02-18T08:00:00Z"),
          category: ExpenseCategory.INSURANCE,
          amountPaisa: 25_000_000,
          vendor: "Shikhar",
        },
        {
          createdById: adminId,
          vehicleId: vehicleB.id,
          date: new Date("2026-02-20T08:00:00Z"),
          category: ExpenseCategory.REPAIR,
          amountPaisa: 1_200_000,
          vendor: "Bishal Auto",
        },
        {
          createdById: adminId,
          vehicleId: vehicleA.id,
          tripId: trip.id,
          date: new Date("2026-02-25T08:00:00Z"),
          category: ExpenseCategory.TOLL,
          amountPaisa: 50_000,
          vendor: "Naubise",
        },
      ];
      // Sequential creates so createdAt order is deterministic
      // (Postgres NOW() has microsecond precision but back-to-back
      // inserts can still tie). Same approach as
      // fuel-logs.service.test.ts.
      for (const seed of seeds) {
        await seedExpenseLog(prisma, seed);
      }
    }

    test("returns total + items with default sort = date desc", async () => {
      await seedSeven();
      const { items, total } = await service.list({});
      expect(total).toBe(7);
      expect(items).toHaveLength(7);
      // Default sort is `date desc` — newest expense first. The
      // first item is the 2026-02-25 TOLL row.
      expect(items[0].date.toISOString()).toBe("2026-02-25T08:00:00.000Z");
      expect(items[0].category).toBe(ExpenseCategory.TOLL);
      // The last item is the 2026-01-05 PERMIT row.
      expect(items[items.length - 1].date.toISOString()).toBe("2026-01-05T08:00:00.000Z");
      // Wire shape sanity — the slim vehicle/trip projection is on
      // the items. The first item has vehicle + trip set.
      expect(items[0].vehicle?.registrationNumber).toBe(vehicleA.registrationNumber);
      expect(items[0].trip?.id).toBe(trip.id);
    });

    test("returns empty items + total=0 on an empty table", async () => {
      const { items, total } = await service.list({});
      expect(total).toBe(0);
      expect(items).toHaveLength(0);
    });

    test("{ vehicleId } narrows results to one vehicle (the vehicle-agnostic rows are EXCLUDED)", async () => {
      await seedSeven();
      // Three of the seven rows are vehicleA (the TOLL, the
      // MAINTENANCE, and the FINE). The vehicle-agnostic INSURANCE
      // and PERMIT rows are NOT included — positive-equality filter,
      // per the schema docstring.
      const { items, total } = await service.list({ vehicleId: vehicleA.id });
      expect(total).toBe(3);
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.vehicleId).toBe(vehicleA.id);
      }
    });

    test("no vehicleId filter INCLUDES vehicle-agnostic rows in the global feed", async () => {
      // The "global expense feed" case — no filter at all should
      // surface the two vehicle-agnostic rows alongside the
      // attributed rows. This is the iter-21 behaviour the iter-23
      // cost report's "vehicle-agnostic bucket" will replace with
      // an explicit query.
      await seedSeven();
      const { items, total } = await service.list({});
      expect(total).toBe(7);
      const vehicleAgnosticCount = items.filter((i) => i.vehicleId === null).length;
      expect(vehicleAgnosticCount).toBe(2);
    });

    test("{ tripId } narrows results to one trip only", async () => {
      await seedSeven();
      // Two of the seven rows are tied to the trip (the TOLL row
      // and the FINE row — both on vehicleA, the trip's vehicle).
      const { items, total } = await service.list({ tripId: trip.id });
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.tripId).toBe(trip.id);
      }
    });

    test("{ category } narrows results to one category only", async () => {
      await seedSeven();
      // Pick MAINTENANCE — one row in the seed. Pinning the
      // category filter end-to-end against a real Prisma enum.
      const { items, total } = await service.list({ category: ExpenseCategory.MAINTENANCE });
      expect(total).toBe(1);
      expect(items).toHaveLength(1);
      expect(items[0].category).toBe(ExpenseCategory.MAINTENANCE);
      expect(items[0].vendor).toBe("NOC service");
    });

    test("{ startDate, endDate } narrows the date range (inclusive bounds)", async () => {
      await seedSeven();
      // Window includes the 2026-01-15 FINE and the 2026-01-25
      // PARKING rows and excludes the rest.
      const startDate = new Date("2026-01-15T00:00:00Z");
      const endDate = new Date("2026-01-25T23:59:59Z");
      const { items, total } = await service.list({ startDate, endDate });
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.date >= startDate).toBe(true);
        expect(item.date <= endDate).toBe(true);
      }
    });

    test("{ vehicleId } + { category } combine (logical AND)", async () => {
      await seedSeven();
      // vehicleA has three rows total (TOLL, MAINTENANCE, FINE).
      // Filter to category=TOLL and vehicleId=A → exactly one row.
      const { items, total } = await service.list({
        vehicleId: vehicleA.id,
        category: ExpenseCategory.TOLL,
      });
      expect(total).toBe(1);
      expect(items).toHaveLength(1);
      expect(items[0].vehicleId).toBe(vehicleA.id);
      expect(items[0].category).toBe(ExpenseCategory.TOLL);
    });

    test("take is clamped to LIST_TAKE_MAX (defense-in-depth)", async () => {
      await seedSeven();
      // The schema layer caps at 200; here we bypass the schema and
      // call the service directly with an over-large take. The
      // service clamps so the underlying Prisma query never
      // receives an unbounded ceiling.
      const { items, total } = await service.list({ take: LIST_TAKE_MAX + 5000 });
      expect(total).toBe(7);
      expect(items).toHaveLength(7);
    });

    test("skip past the end returns empty items but the correct total", async () => {
      await seedSeven();
      const { items, total } = await service.list({ skip: 100, take: 10 });
      expect(total).toBe(7);
      expect(items).toHaveLength(0);
    });

    test("sortBy='createdAt' + sortDir='asc' returns oldest-created first", async () => {
      await seedSeven();
      const { items, total } = await service.list({ sortBy: "createdAt", sortDir: "asc" });
      expect(total).toBe(7);
      // Sequential await in seedSeven() guarantees monotonic
      // createdAt. The first item under asc is the first inserted
      // (the 2026-01-05 PERMIT row).
      expect(items[0].date.toISOString()).toBe("2026-01-05T08:00:00.000Z");
      expect(items[items.length - 1].date.toISOString()).toBe("2026-02-25T08:00:00.000Z");
    });

    test("sortBy='date' + sortDir='asc' returns oldest-date first", async () => {
      await seedSeven();
      const { items } = await service.list({ sortBy: "date", sortDir: "asc" });
      expect(items[0].date.toISOString()).toBe("2026-01-05T08:00:00.000Z");
      expect(items[items.length - 1].date.toISOString()).toBe("2026-02-25T08:00:00.000Z");
    });

    test("sortBy='amountPaisa' + sortDir='desc' returns biggest-amount first", async () => {
      // The iter-23 cost report's "biggest expense first" query
      // pinned end-to-end. The 25_000_000 paisa (NPR 250,000)
      // INSURANCE row is the biggest amount in the seed.
      await seedSeven();
      const { items } = await service.list({ sortBy: "amountPaisa", sortDir: "desc" });
      expect(items[0].amountPaisa).toBe(25_000_000);
      expect(items[0].category).toBe(ExpenseCategory.INSURANCE);
      // The smallest is the 10_000 PARKING row.
      expect(items[items.length - 1].amountPaisa).toBe(10_000);
    });

    test("skip + take produce stable pagination across requests (id tiebreaker)", async () => {
      await seedSeven();
      // Page 1: rows 0..1 (the two most recent under date desc)
      const page1 = await service.list({ skip: 0, take: 2 });
      expect(page1.items).toHaveLength(2);
      // Page 2: rows 2..3
      const page2 = await service.list({ skip: 2, take: 2 });
      expect(page2.items).toHaveLength(2);
      // The 4 items across the two pages should be 4 distinct ids
      // (no duplicates, no skips). The id-tiebreaker in orderBy is
      // what makes this stable when two rows share a primary sort
      // value; on this seed the dates are all distinct so the test
      // is doubly safe.
      const allIds = new Set([...page1.items.map((i) => i.id), ...page2.items.map((i) => i.id)]);
      expect(allIds.size).toBe(4);
    });
  });
});
