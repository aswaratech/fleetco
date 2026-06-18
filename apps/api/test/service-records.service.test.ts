import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ExpenseCategory } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import {
  ServiceRecordsService,
  type CreateServiceRecordInput,
} from "../src/modules/maintenance/service-records.service";
import { resetDb } from "./db";
import { seedExpenseLog } from "./fixtures/expense-log";

// Integration tests for ServiceRecordsService against a real Postgres (ADR-0037
// B3). A ServiceRecord is a completed service event. Coverage: filter / sort /
// paginate, the schedule↔vehicle consistency check (ADR-0037 c5), the
// nullable-FK ad-hoc (no schedule) path, and the stale-FK P2003 → 400 mapping.
// There is no unique constraint on ServiceRecord, so no P2002 path; and nothing
// FKs into it, so delete has no 409 arm.

describe("ServiceRecordsService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: ServiceRecordsService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [ServiceRecordsService, PrismaService],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    service = module.get(ServiceRecordsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: { id: adminId, email: `admin-${adminId}@fleetco.test`, name: "Test Admin" },
    });
  });

  async function seedVehicle() {
    return prisma.vehicle.create({
      data: {
        registrationNumber: `BA-${randomUUID().slice(0, 8)}`,
        kind: "TRUCK",
        make: "Tata",
        model: "LPK 2518",
        year: 2020,
        acquiredAt: new Date("2020-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
  }

  async function seedSchedule(vehicleId: string, name = "Oil change") {
    return prisma.serviceSchedule.create({
      data: {
        vehicleId,
        name,
        intervalType: "DISTANCE_KM",
        intervalValue: 5000,
        lastServiceAt: new Date("2026-01-01T00:00:00Z"),
        lastServiceOdometerKm: 0,
        createdById: adminId,
      },
    });
  }

  function makeInput(
    vehicleId: string,
    overrides: Partial<CreateServiceRecordInput> = {},
  ): CreateServiceRecordInput {
    return {
      vehicleId,
      serviceScheduleId: overrides.serviceScheduleId,
      expenseLogId: overrides.expenseLogId,
      performedAt: overrides.performedAt ?? new Date("2026-02-01T00:00:00Z"),
      odometerKm: overrides.odometerKm,
      engineHours: overrides.engineHours,
      notes: overrides.notes,
    };
  }

  // Assert an async call rejects with a BadRequestException whose message
  // contains `contains`. Terser than the inline try/catch the older cases use.
  async function expectBadRequest(fn: () => Promise<unknown>, contains: string): Promise<void> {
    let thrown: unknown;
    try {
      await fn();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toContain(contains);
  }

  describe("findById()", () => {
    test("present / null branches", async () => {
      const v = await seedVehicle();
      const created = await service.create(makeInput(v.id), adminId);
      expect((await service.findById(created.id))?.id).toBe(created.id);
      expect(await service.findById("nonexistent-id")).toBeNull();
    });
  });

  describe("list() — filter / sort / paginate", () => {
    test("vehicleId and serviceScheduleId filters narrow results", async () => {
      const v1 = await seedVehicle();
      const v2 = await seedVehicle();
      const sched = await seedSchedule(v1.id);
      await service.create(makeInput(v1.id, { serviceScheduleId: sched.id }), adminId);
      await service.create(makeInput(v1.id), adminId); // ad-hoc, no schedule
      await service.create(makeInput(v2.id), adminId);

      const all = await service.list({});
      expect(all.total).toBe(3);

      const byVehicle = await service.list({ vehicleId: v1.id });
      expect(byVehicle.total).toBe(2);
      expect(byVehicle.items.every((r) => r.vehicleId === v1.id)).toBe(true);

      const bySchedule = await service.list({ serviceScheduleId: sched.id });
      expect(bySchedule.total).toBe(1);
      expect(bySchedule.items[0]?.serviceScheduleId).toBe(sched.id);
    });

    test("default sort is performedAt desc (most recent service first)", async () => {
      const v = await seedVehicle();
      const old = await service.create(
        makeInput(v.id, { performedAt: new Date("2026-01-01T00:00:00Z") }),
        adminId,
      );
      const mid = await service.create(
        makeInput(v.id, { performedAt: new Date("2026-03-01T00:00:00Z") }),
        adminId,
      );
      const recent = await service.create(
        makeInput(v.id, { performedAt: new Date("2026-06-01T00:00:00Z") }),
        adminId,
      );
      const result = await service.list({});
      expect(result.items.map((r) => r.id)).toEqual([recent.id, mid.id, old.id]);
    });

    test("performedAt asc reverses the order", async () => {
      const v = await seedVehicle();
      const a = await service.create(
        makeInput(v.id, { performedAt: new Date("2026-01-01T00:00:00Z") }),
        adminId,
      );
      const b = await service.create(
        makeInput(v.id, { performedAt: new Date("2026-06-01T00:00:00Z") }),
        adminId,
      );
      const result = await service.list({ sortBy: "performedAt", sortDir: "asc" });
      expect(result.items.map((r) => r.id)).toEqual([a.id, b.id]);
    });

    test("pagination window + take clamp + skip-past-end", async () => {
      const v = await seedVehicle();
      for (let i = 0; i < 5; i++) {
        await service.create(
          makeInput(v.id, { performedAt: new Date(`2026-0${i + 1}-01T00:00:00Z`) }),
          adminId,
        );
      }
      const page = await service.list({ skip: 2, take: 2, sortBy: "performedAt", sortDir: "asc" });
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(5);

      const clamped = await service.list({ take: 10_000 });
      expect(clamped.items.length).toBeLessThanOrEqual(5);

      const past = await service.list({ skip: 100, take: 10 });
      expect(past.items).toHaveLength(0);
      expect(past.total).toBe(5);
    });
  });

  describe("create()", () => {
    test("ad-hoc record (no schedule) persists with createdById and null serviceScheduleId", async () => {
      const v = await seedVehicle();
      const created = await service.create(
        makeInput(v.id, { odometerKm: 50_000, notes: "Roadside repair" }),
        adminId,
      );
      expect(created.createdById).toBe(adminId);
      expect(created.serviceScheduleId).toBeNull();
      expect(created.odometerKm).toBe(50_000);
      expect(created.engineHours).toBeNull();
      expect(created.notes).toBe("Roadside repair");
    });

    test("record against a schedule on the same vehicle links successfully", async () => {
      const v = await seedVehicle();
      const sched = await seedSchedule(v.id);
      const created = await service.create(
        makeInput(v.id, { serviceScheduleId: sched.id }),
        adminId,
      );
      expect(created.serviceScheduleId).toBe(sched.id);
    });

    test("schedule on a DIFFERENT vehicle → BadRequestException (consistency, c5)", async () => {
      const v1 = await seedVehicle();
      const v2 = await seedVehicle();
      const schedOnV2 = await seedSchedule(v2.id);
      let thrown: unknown;
      try {
        await service.create(makeInput(v1.id, { serviceScheduleId: schedOnV2.id }), adminId);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toContain("different vehicle");
    });

    test("nonexistent (cuid-shaped) serviceScheduleId → BadRequestException", async () => {
      const v = await seedVehicle();
      let thrown: unknown;
      try {
        await service.create(
          makeInput(v.id, { serviceScheduleId: "cknonexistentschedule000" }),
          adminId,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
    });

    test("stale vehicleId → BadRequestException (P2003 → 400)", async () => {
      let thrown: unknown;
      try {
        await service.create(makeInput("cknonexistentvehicle0000"), adminId);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toContain("does not exist");
    });
  });

  // ADR-0037 c6: a ServiceRecord REFERENCES its cost via expenseLogId; the
  // referenced ExpenseLog must be MAINTENANCE/REPAIR and on the same vehicle.
  describe("create() — ExpenseLog cost-link (c6)", () => {
    test("links a same-vehicle MAINTENANCE expense", async () => {
      const v = await seedVehicle();
      const expense = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: v.id,
        category: ExpenseCategory.MAINTENANCE,
      });
      const record = await service.create(makeInput(v.id, { expenseLogId: expense.id }), adminId);
      expect(record.expenseLogId).toBe(expense.id);
    });

    test("links a same-vehicle REPAIR expense", async () => {
      const v = await seedVehicle();
      const expense = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: v.id,
        category: ExpenseCategory.REPAIR,
      });
      const record = await service.create(makeInput(v.id, { expenseLogId: expense.id }), adminId);
      expect(record.expenseLogId).toBe(expense.id);
    });

    test("a non-maintenance category (TOLL) → BadRequestException (names the category)", async () => {
      const v = await seedVehicle();
      const expense = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: v.id,
        category: ExpenseCategory.TOLL,
      });
      await expectBadRequest(
        () => service.create(makeInput(v.id, { expenseLogId: expense.id }), adminId),
        "category",
      );
    });

    test("an expense on a DIFFERENT vehicle → BadRequestException", async () => {
      const v1 = await seedVehicle();
      const v2 = await seedVehicle();
      const expenseOnV2 = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: v2.id,
        category: ExpenseCategory.MAINTENANCE,
      });
      await expectBadRequest(
        () => service.create(makeInput(v1.id, { expenseLogId: expenseOnV2.id }), adminId),
        "not attributed to this vehicle",
      );
    });

    test("a vehicle-agnostic (null-vehicle) expense → BadRequestException", async () => {
      const v = await seedVehicle();
      const agnostic = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: null,
        category: ExpenseCategory.MAINTENANCE,
      });
      await expectBadRequest(
        () => service.create(makeInput(v.id, { expenseLogId: agnostic.id }), adminId),
        "not attributed to this vehicle",
      );
    });

    test("a nonexistent (cuid-shaped) expenseLogId → BadRequestException", async () => {
      const v = await seedVehicle();
      await expectBadRequest(
        () =>
          service.create(makeInput(v.id, { expenseLogId: "cknonexistentexpense0000" }), adminId),
        "does not exist",
      );
    });

    test("update() links then unlinks the expense, re-validating against the stored vehicle", async () => {
      const v = await seedVehicle();
      const expense = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: v.id,
        category: ExpenseCategory.MAINTENANCE,
      });
      const record = await service.create(makeInput(v.id), adminId); // no expense at first
      const linked = await service.update(record.id, { expenseLogId: expense.id });
      expect(linked?.expenseLogId).toBe(expense.id);
      const unlinked = await service.update(record.id, { expenseLogId: null });
      expect(unlinked?.expenseLogId).toBeNull();
    });

    test("update() to a different-vehicle expense → BadRequestException", async () => {
      const v1 = await seedVehicle();
      const v2 = await seedVehicle();
      const expenseOnV2 = await seedExpenseLog(prisma, {
        createdById: adminId,
        vehicleId: v2.id,
        category: ExpenseCategory.MAINTENANCE,
      });
      const record = await service.create(makeInput(v1.id), adminId);
      await expectBadRequest(
        () => service.update(record.id, { expenseLogId: expenseOnV2.id }),
        "not attributed",
      );
    });
  });

  // ADR-0037 c5: recording a service against a schedule advances that schedule's
  // last-service anchor forward, in the SAME $transaction as the record insert,
  // under the monotonic "once forward, stays forward" rule.
  describe("create() — schedule anchor-advance (c5)", () => {
    // Seed a DISTANCE_KM schedule already advanced to a known anchor so the
    // backward-movement cases have something to (not) move.
    async function seedAdvancedSchedule(vehicleId: string) {
      return prisma.serviceSchedule.create({
        data: {
          vehicleId,
          name: "Oil change",
          intervalType: "DISTANCE_KM",
          intervalValue: 5000,
          lastServiceAt: new Date("2026-03-01T00:00:00Z"),
          lastServiceOdometerKm: 5000,
          createdById: adminId,
        },
      });
    }

    test("a forward service advances the anchor (date + odometer), atomically with the record", async () => {
      const v = await seedVehicle();
      const sched = await seedSchedule(v.id); // anchor: 2026-01-01 / 0 km
      const record = await service.create(
        makeInput(v.id, {
          serviceScheduleId: sched.id,
          performedAt: new Date("2026-03-01T00:00:00Z"),
          odometerKm: 5200,
        }),
        adminId,
      );
      const after = await prisma.serviceSchedule.findUniqueOrThrow({ where: { id: sched.id } });
      expect(after.lastServiceAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
      expect(after.lastServiceOdometerKm).toBe(5200);
      // Atomic: the record itself also persisted in the same transaction.
      expect(await prisma.serviceRecord.findUnique({ where: { id: record.id } })).not.toBeNull();
    });

    test("a backdated / lower-reading correction does NOT move the anchor backward", async () => {
      const v = await seedVehicle();
      const sched = await seedAdvancedSchedule(v.id); // anchor: 2026-03-01 / 5000 km
      await service.create(
        makeInput(v.id, {
          serviceScheduleId: sched.id,
          performedAt: new Date("2026-01-15T00:00:00Z"),
          odometerKm: 4000,
        }),
        adminId,
      );
      const after = await prisma.serviceSchedule.findUniqueOrThrow({ where: { id: sched.id } });
      expect(after.lastServiceAt.toISOString()).toBe("2026-03-01T00:00:00.000Z"); // unchanged
      expect(after.lastServiceOdometerKm).toBe(5000); // unchanged
    });

    test("each anchor field is independent: a higher km but earlier date moves only km", async () => {
      const v = await seedVehicle();
      const sched = await seedAdvancedSchedule(v.id); // 2026-03-01 / 5000 km
      await service.create(
        makeInput(v.id, {
          serviceScheduleId: sched.id,
          performedAt: new Date("2026-02-01T00:00:00Z"), // earlier → date stays
          odometerKm: 6000, // higher → km advances
        }),
        adminId,
      );
      const after = await prisma.serviceSchedule.findUniqueOrThrow({ where: { id: sched.id } });
      expect(after.lastServiceAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
      expect(after.lastServiceOdometerKm).toBe(6000);
    });

    test("a null meter anchor is seeded by the first recorded reading", async () => {
      const v = await seedVehicle();
      const sched = await prisma.serviceSchedule.create({
        data: {
          vehicleId: v.id,
          name: "Oil change",
          intervalType: "DISTANCE_KM",
          intervalValue: 5000,
          lastServiceAt: new Date("2026-01-01T00:00:00Z"),
          lastServiceOdometerKm: null,
          createdById: adminId,
        },
      });
      await service.create(
        makeInput(v.id, {
          serviceScheduleId: sched.id,
          performedAt: new Date("2026-02-01T00:00:00Z"),
          odometerKm: 4200,
        }),
        adminId,
      );
      const after = await prisma.serviceSchedule.findUniqueOrThrow({ where: { id: sched.id } });
      expect(after.lastServiceOdometerKm).toBe(4200);
    });

    test("an ENGINE_HOURS schedule's hours anchor advances forward", async () => {
      const v = await seedVehicle();
      const sched = await prisma.serviceSchedule.create({
        data: {
          vehicleId: v.id,
          name: "Hydraulic service",
          intervalType: "ENGINE_HOURS",
          intervalValue: 2500,
          lastServiceAt: new Date("2026-01-01T00:00:00Z"),
          lastServiceEngineHours: 2000,
          createdById: adminId,
        },
      });
      await service.create(
        makeInput(v.id, {
          serviceScheduleId: sched.id,
          performedAt: new Date("2026-02-01T00:00:00Z"),
          engineHours: 2300,
        }),
        adminId,
      );
      const after = await prisma.serviceSchedule.findUniqueOrThrow({ where: { id: sched.id } });
      expect(after.lastServiceEngineHours).toBe(2300);
    });

    test("an ad-hoc record (no schedule) touches no schedule and still persists", async () => {
      const v = await seedVehicle();
      const sched = await seedAdvancedSchedule(v.id);
      const record = await service.create(makeInput(v.id, { odometerKm: 9999 }), adminId); // no scheduleId
      expect(record.serviceScheduleId).toBeNull();
      // The unrelated schedule's anchor is untouched.
      const after = await prisma.serviceSchedule.findUniqueOrThrow({ where: { id: sched.id } });
      expect(after.lastServiceOdometerKm).toBe(5000);
      expect(after.lastServiceAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    });
  });

  describe("update()", () => {
    test("returns null when not found", async () => {
      expect(await service.update("nonexistent-id", { notes: "x" })).toBeNull();
    });

    test("happy path updates performedAt and notes", async () => {
      const v = await seedVehicle();
      const created = await service.create(makeInput(v.id, { notes: "old" }), adminId);
      const when = new Date("2026-05-05T00:00:00Z");
      const updated = await service.update(created.id, { performedAt: when, notes: "new" });
      expect(updated?.performedAt.toISOString()).toBe(when.toISOString());
      expect(updated?.notes).toBe("new");
    });

    test("re-link serviceScheduleId to a same-vehicle schedule succeeds", async () => {
      const v = await seedVehicle();
      const sched = await seedSchedule(v.id);
      const created = await service.create(makeInput(v.id), adminId); // ad-hoc
      const updated = await service.update(created.id, { serviceScheduleId: sched.id });
      expect(updated?.serviceScheduleId).toBe(sched.id);
    });

    test("re-link to a different-vehicle schedule → BadRequestException", async () => {
      const v1 = await seedVehicle();
      const v2 = await seedVehicle();
      const schedOnV2 = await seedSchedule(v2.id);
      const created = await service.create(makeInput(v1.id), adminId);
      let thrown: unknown;
      try {
        await service.update(created.id, { serviceScheduleId: schedOnV2.id });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BadRequestException);
    });

    test("explicit null unlinks the schedule; absent leaves it alone", async () => {
      const v = await seedVehicle();
      const sched = await seedSchedule(v.id);
      const created = await service.create(
        makeInput(v.id, { serviceScheduleId: sched.id, odometerKm: 100 }),
        adminId,
      );
      const unlinked = await service.update(created.id, { serviceScheduleId: null });
      expect(unlinked?.serviceScheduleId).toBeNull();
      // odometerKm untouched (not mentioned in the patch).
      expect(unlinked?.odometerKm).toBe(100);

      const clearedMeter = await service.update(created.id, { odometerKm: null });
      expect(clearedMeter?.odometerKm).toBeNull();
    });
  });

  describe("delete()", () => {
    test("happy path true; not-found false (no inbound-FK 409 arm)", async () => {
      const v = await seedVehicle();
      const created = await service.create(makeInput(v.id), adminId);
      expect(await service.delete(created.id)).toBe(true);
      expect(await service.delete(created.id)).toBe(false);
    });
  });
});
