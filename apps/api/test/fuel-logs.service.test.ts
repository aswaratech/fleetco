import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { type Driver, type Trip, type Vehicle } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { FuelLogsService, LIST_TAKE_MAX } from "../src/modules/fuel-logs/fuel-logs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for FuelLogsService against a real Postgres.
// Mirrors the iter-17 jobs.service.test.ts in shape; the iter-19
// kickoff (Checkpoint 2, last paragraph) names the coverage areas:
//
//   1. list() returns total + items; default sort is `date desc`.
//   2. Filter composition: { vehicleId } narrows correctly;
//      { startDate, endDate } narrows correctly; the two combine.
//   3. `take` is clamped to LIST_TAKE_MAX; `skip` past the end
//      returns empty items + correct total.
//   4. `sortBy: "createdAt"` works; sortBy/sortDir round-trip.
//   5. getById() returns the nested Vehicle + Trip; missing id →
//      NotFoundException.
//
// FuelLog has three FK references (vehicleId, tripId nullable, and
// createdById). The seed below builds one admin user, two Vehicles,
// one Driver, and one Trip — enough to exercise the {vehicleId}
// narrowing across two vehicles and the nullable tripId both ways.

interface SeedFuelLogInput {
  vehicleId?: string;
  tripId?: string | null;
  date?: Date;
  litersMl?: number;
  pricePerLiterPaisa?: number;
  totalCostPaisa?: number;
  odometerReadingKm?: number | null;
  station?: string | null;
  receiptNumber?: string | null;
  notes?: string | null;
}

describe("FuelLogsService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: FuelLogsService;
  let adminId: string;
  let vehicleA: Vehicle;
  let vehicleB: Vehicle;
  let driver: Driver;
  let trip: Trip;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [FuelLogsService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(FuelLogsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    // FuelLog.vehicleId is a non-null FK to Vehicle.id; tripId is a
    // nullable FK to Trip.id; createdById is a non-null FK to User.id.
    // The seed builds two vehicles (so the {vehicleId} narrowing test
    // can prove the filter is real), one driver + one trip (so the
    // nullable tripId can be exercised both ways), and one admin user
    // for createdById. Auth-domain rows are left untouched here.
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

  async function seedFuelLog(input: SeedFuelLogInput = {}) {
    return prisma.fuelLog.create({
      data: {
        vehicleId: input.vehicleId ?? vehicleA.id,
        tripId: input.tripId === undefined ? null : input.tripId,
        date: input.date ?? new Date("2026-02-15T08:00:00Z"),
        // 12.345 L
        litersMl: input.litersMl ?? 12_345,
        // Rs. 110.50 / L = 11050 paisa
        pricePerLiterPaisa: input.pricePerLiterPaisa ?? 11_050,
        // Derived: (12345 * 11050) / 1000 = 136_412 paisa (truncated)
        // — the seed pre-computes this since iter 19 ships the read
        // path; the iter-20 write path lands the derivation in the
        // service.
        totalCostPaisa: input.totalCostPaisa ?? 136_412,
        odometerReadingKm: input.odometerReadingKm === undefined ? null : input.odometerReadingKm,
        station: input.station === undefined ? null : input.station,
        receiptNumber: input.receiptNumber === undefined ? null : input.receiptNumber,
        notes: input.notes === undefined ? null : input.notes,
        createdById: adminId,
      },
    });
  }

  describe("findById() / getById()", () => {
    test("findById() returns the row with nested vehicle and trip when present", async () => {
      const created = await seedFuelLog({
        tripId: trip.id,
        station: "NOC Naxal",
      });
      const fetched = await service.findById(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.station).toBe("NOC Naxal");
      expect(fetched?.litersMl).toBe(12_345);
      expect(fetched?.pricePerLiterPaisa).toBe(11_050);
      expect(fetched?.totalCostPaisa).toBe(136_412);
      // DETAIL_INCLUDE contract — pinned here so a refactor that
      // dropped the relations would fail loudly.
      expect(fetched?.vehicle.id).toBe(vehicleA.id);
      expect(fetched?.vehicle.registrationNumber).toBe(vehicleA.registrationNumber);
      expect(fetched?.trip?.id).toBe(trip.id);
    });

    test("findById() returns the row with trip === null when not tied to a trip", async () => {
      // The canonical "depot top-up between jobs" case from the
      // glossary entry. Trip should be null in the nested include.
      const created = await seedFuelLog({ tripId: null });
      const fetched = await service.findById(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.trip).toBeNull();
      expect(fetched?.vehicle.id).toBe(vehicleA.id);
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

    test("getById() returns the row with nested relations on the happy path", async () => {
      const created = await seedFuelLog({ tripId: trip.id });
      const fetched = await service.getById(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.vehicle.id).toBe(vehicleA.id);
      expect(fetched.trip?.id).toBe(trip.id);
    });
  });

  describe("list() — filter / sort / paginate", () => {
    // Seed six fuel logs spread across two vehicles and two months so
    // the assertions below can be precise about which rows come back
    // for each query.
    //
    // Rows (ordered by date desc — which is the default list sort —
    // for human readability of the assertions):
    //
    //   v=A trip=set  date=2026-02-25  litersMl=12345  station="NOC Naxal"
    //   v=B trip=null date=2026-02-20  litersMl=20000  station=null
    //   v=A trip=null date=2026-02-15  litersMl=10000  station="NOC Thapathali"
    //   v=B trip=null date=2026-01-25  litersMl=18000  station="Surya Petrol"
    //   v=A trip=set  date=2026-01-15  litersMl=15000  station="NOC Naxal"
    //   v=A trip=null date=2026-01-05  litersMl=8000   station="NOC Thapathali"
    async function seedSix(): Promise<void> {
      const seeds: SeedFuelLogInput[] = [
        {
          vehicleId: vehicleA.id,
          tripId: null,
          date: new Date("2026-01-05T08:00:00Z"),
          litersMl: 8_000,
          station: "NOC Thapathali",
        },
        {
          vehicleId: vehicleA.id,
          tripId: trip.id,
          date: new Date("2026-01-15T08:00:00Z"),
          litersMl: 15_000,
          station: "NOC Naxal",
        },
        {
          vehicleId: vehicleB.id,
          tripId: null,
          date: new Date("2026-01-25T08:00:00Z"),
          litersMl: 18_000,
          station: "Surya Petrol",
        },
        {
          vehicleId: vehicleA.id,
          tripId: null,
          date: new Date("2026-02-15T08:00:00Z"),
          litersMl: 10_000,
          station: "NOC Thapathali",
        },
        {
          vehicleId: vehicleB.id,
          tripId: null,
          date: new Date("2026-02-20T08:00:00Z"),
          litersMl: 20_000,
          station: null,
        },
        {
          vehicleId: vehicleA.id,
          tripId: trip.id,
          date: new Date("2026-02-25T08:00:00Z"),
          litersMl: 12_345,
          station: "NOC Naxal",
        },
      ];
      // Sequential creates so createdAt order is deterministic
      // (Postgres NOW() has microsecond precision but back-to-back
      // inserts can still tie). Same approach as jobs.service.test.ts.
      for (const seed of seeds) {
        await seedFuelLog(seed);
      }
    }

    test("returns total + items with default sort = date desc", async () => {
      await seedSix();
      const { items, total } = await service.list({});
      expect(total).toBe(6);
      expect(items).toHaveLength(6);
      // Default sort is `date desc` — newest fill first. The first
      // item is the 2026-02-25 row.
      expect(items[0].date.toISOString()).toBe("2026-02-25T08:00:00.000Z");
      // The last item is the 2026-01-05 row.
      expect(items[items.length - 1].date.toISOString()).toBe("2026-01-05T08:00:00.000Z");
      // Wire shape sanity — the slim vehicle/trip projection is on
      // the items.
      expect(items[0].vehicle.registrationNumber).toBe(vehicleA.registrationNumber);
      expect(items[0].trip?.id).toBe(trip.id);
    });

    test("returns empty items + total=0 on an empty table", async () => {
      const { items, total } = await service.list({});
      expect(total).toBe(0);
      expect(items).toHaveLength(0);
    });

    test("{ vehicleId } narrows results to one vehicle only", async () => {
      await seedSix();
      const { items, total } = await service.list({ vehicleId: vehicleA.id });
      // Four of the six rows are vehicleA; the count and the items
      // should agree.
      expect(total).toBe(4);
      expect(items).toHaveLength(4);
      for (const item of items) {
        expect(item.vehicleId).toBe(vehicleA.id);
      }
    });

    test("{ tripId } narrows results to one trip only", async () => {
      await seedSix();
      const { items, total } = await service.list({ tripId: trip.id });
      // Two of the six rows are tied to the trip.
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.tripId).toBe(trip.id);
      }
    });

    test("{ startDate, endDate } narrows the date range (inclusive bounds)", async () => {
      await seedSix();
      // Pick a window that includes the 2026-01-15 row and the
      // 2026-01-25 row but excludes the rest. The bounds are
      // inclusive at both ends.
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

    test("{ vehicleId } + { startDate, endDate } combine (logical AND)", async () => {
      await seedSix();
      // vehicleA has two rows in Jan (the 2026-01-05 and 2026-01-15
      // rows) and two in Feb. Bound to Jan and the count should be 2.
      const { items, total } = await service.list({
        vehicleId: vehicleA.id,
        startDate: new Date("2026-01-01T00:00:00Z"),
        endDate: new Date("2026-01-31T23:59:59Z"),
      });
      expect(total).toBe(2);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.vehicleId).toBe(vehicleA.id);
      }
    });

    test("take is clamped to LIST_TAKE_MAX (defense-in-depth)", async () => {
      await seedSix();
      // The schema layer caps at 200; here we bypass the schema and
      // call the service directly with an over-large take. The
      // service clamps so the underlying Prisma query never receives
      // an unbounded ceiling.
      const { items, total } = await service.list({ take: LIST_TAKE_MAX + 5000 });
      expect(total).toBe(6);
      // Six rows fit within the clamped ceiling, so we get all six
      // back — the assertion is that the clamp did not error and did
      // not somehow truncate within the dataset size.
      expect(items).toHaveLength(6);
    });

    test("skip past the end returns empty items but the correct total", async () => {
      await seedSix();
      const { items, total } = await service.list({ skip: 100, take: 10 });
      expect(total).toBe(6);
      expect(items).toHaveLength(0);
    });

    test("sortBy='createdAt' + sortDir='asc' returns oldest-created first", async () => {
      await seedSix();
      const { items, total } = await service.list({ sortBy: "createdAt", sortDir: "asc" });
      expect(total).toBe(6);
      // Sequential await in seedSix() guarantees monotonic
      // createdAt. The first item under asc is the first inserted
      // (the 2026-01-05 row).
      expect(items[0].date.toISOString()).toBe("2026-01-05T08:00:00.000Z");
      // And the last is the most recently inserted (the 2026-02-25
      // row).
      expect(items[items.length - 1].date.toISOString()).toBe("2026-02-25T08:00:00.000Z");
    });

    test("sortBy='date' + sortDir='asc' returns oldest-date first", async () => {
      await seedSix();
      const { items } = await service.list({ sortBy: "date", sortDir: "asc" });
      expect(items[0].date.toISOString()).toBe("2026-01-05T08:00:00.000Z");
      expect(items[items.length - 1].date.toISOString()).toBe("2026-02-25T08:00:00.000Z");
    });

    test("skip + take produce stable pagination across requests", async () => {
      await seedSix();
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
