import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ExpenseCategory } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { ServiceRecordsController } from "../src/modules/maintenance/service-records.controller";
import { ServiceRecordsService } from "../src/modules/maintenance/service-records.service";
import {
  CreateServiceRecordSchema,
  ListServiceRecordsQuerySchema,
  UpdateServiceRecordSchema,
} from "../src/modules/maintenance/service-records.schemas";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { seedExpenseLog } from "./fixtures/expense-log";

describe("ServiceRecordsController schemas (B3 contract)", () => {
  describe("ListServiceRecordsQuerySchema", () => {
    const pipe = new ZodValidationPipe(ListServiceRecordsQuerySchema);

    test("bogus query key → BadRequestException (.strict())", () => {
      expect(() => pipe.transform({ vehicel: "x" })).toThrow(BadRequestException);
    });

    test("off-whitelist sortBy (odometerKm) → BadRequestException", () => {
      expect(() => pipe.transform({ sortBy: "odometerKm" })).toThrow(BadRequestException);
    });

    test("non-cuid serviceScheduleId filter → BadRequestException", () => {
      expect(() => pipe.transform({ serviceScheduleId: "nope" })).toThrow(BadRequestException);
    });

    test("take above 200 → BadRequestException", () => {
      expect(() => pipe.transform({ take: "999" })).toThrow(BadRequestException);
    });

    test("valid query coerces types and passes through", () => {
      const result = pipe.transform({
        sortBy: "performedAt",
        sortDir: "asc",
        skip: "5",
        take: "20",
      });
      expect(result.sortBy).toBe("performedAt");
      expect(result.skip).toBe(5);
      expect(result.take).toBe(20);
    });
  });

  describe("CreateServiceRecordSchema", () => {
    const pipe = new ZodValidationPipe(CreateServiceRecordSchema);

    test("bogus body key (createdById) → BadRequestException", () => {
      expect(() =>
        pipe.transform({
          vehicleId: "ckvehicle00000000",
          performedAt: "2026-02-01",
          createdById: "smuggled",
        }),
      ).toThrow(BadRequestException);
    });

    test("missing vehicleId / performedAt → BadRequestException", () => {
      expect(() => pipe.transform({ vehicleId: "ckvehicle00000000" })).toThrow(BadRequestException);
      expect(() => pipe.transform({ performedAt: "2026-02-01" })).toThrow(BadRequestException);
    });

    test("non-cuid serviceScheduleId → BadRequestException", () => {
      expect(() =>
        pipe.transform({
          vehicleId: "ckvehicle00000000",
          performedAt: "2026-02-01",
          serviceScheduleId: "x",
        }),
      ).toThrow(BadRequestException);
    });

    test("non-cuid expenseLogId → BadRequestException", () => {
      expect(() =>
        pipe.transform({
          vehicleId: "ckvehicle00000000",
          performedAt: "2026-02-01",
          expenseLogId: "nope",
        }),
      ).toThrow(BadRequestException);
    });

    test("negative meter reading → BadRequestException", () => {
      expect(() =>
        pipe.transform({
          vehicleId: "ckvehicle00000000",
          performedAt: "2026-02-01",
          odometerKm: -5,
        }),
      ).toThrow(BadRequestException);
    });

    test("valid minimal body parses; performedAt coerced to Date; nullable fields accept null", () => {
      const parsed = pipe.transform({
        vehicleId: "ckvehicle00000000",
        performedAt: "2026-02-01",
        serviceScheduleId: null,
        expenseLogId: null,
        odometerKm: null,
        engineHours: null,
        notes: null,
      });
      expect(parsed.vehicleId).toBe("ckvehicle00000000");
      expect(parsed.performedAt).toBeInstanceOf(Date);
      expect(parsed.serviceScheduleId).toBeNull();
      expect(parsed.expenseLogId).toBeNull();
    });
  });

  describe("UpdateServiceRecordSchema", () => {
    const pipe = new ZodValidationPipe(UpdateServiceRecordSchema);

    test("empty body → BadRequestException (at-least-one-field refine)", () => {
      expect(() => pipe.transform({})).toThrow(BadRequestException);
    });

    test("immutable vehicleId is rejected (.strict())", () => {
      expect(() => pipe.transform({ vehicleId: "ckvehicle00000000" })).toThrow(BadRequestException);
    });

    test("explicit serviceScheduleId null (unlink) is accepted", () => {
      expect(pipe.transform({ serviceScheduleId: null }).serviceScheduleId).toBeNull();
    });
  });
});

describe("ServiceRecordsController (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: ServiceRecordsController;
  let service: ServiceRecordsService;
  let adminId: string;
  let vehicleId: string;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [ServiceRecordsController],
      providers: [
        ServiceRecordsService,
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
    service = module.get(ServiceRecordsService);
    controller = module.get(ServiceRecordsController);
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
    const vehicle = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA-${randomUUID().slice(0, 8)}`,
        kind: "TRUCK",
        make: "Tata",
        model: "LPK",
        year: 2020,
        acquiredAt: new Date("2020-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    vehicleId = vehicle.id;
    fakeRequest = { session: { user: { id: adminId } } } as unknown as AuthenticatedRequest;
  });

  test("list returns the { items, total, skip, take, sortBy, sortDir } shape", async () => {
    await controller.create(
      { vehicleId, performedAt: new Date("2026-02-01T00:00:00Z") },
      fakeRequest,
    );
    const response = await controller.list({ vehicleId, take: 10 });
    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "performedAt",
      sortDir: "desc",
    });
    expect(response.items).toHaveLength(1);
  });

  test("getById returns the record; unknown id → NotFoundException (404)", async () => {
    const created = await controller.create(
      { vehicleId, performedAt: new Date("2026-02-01T00:00:00Z") },
      fakeRequest,
    );
    expect((await controller.getById(created.id)).id).toBe(created.id);
    await expect(controller.getById("nonexistent-record-id")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test("create persists an ad-hoc record with createdById from the session and null schedule", async () => {
    const created = await controller.create(
      { vehicleId, performedAt: new Date("2026-02-01T00:00:00Z"), odometerKm: 75_000 },
      fakeRequest,
    );
    expect(created.createdById).toBe(adminId);
    expect(created.serviceScheduleId).toBeNull();
    expect(created.odometerKm).toBe(75_000);
  });

  test("create with a linked same-vehicle MAINTENANCE expense persists expenseLogId", async () => {
    const expense = await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId,
      category: ExpenseCategory.MAINTENANCE,
    });
    const created = await controller.create(
      { vehicleId, performedAt: new Date("2026-02-01T00:00:00Z"), expenseLogId: expense.id },
      fakeRequest,
    );
    expect(created.expenseLogId).toBe(expense.id);
  });

  test("create with a schedule on a different vehicle → BadRequestException (400 bubbles)", async () => {
    const otherVehicle = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA-${randomUUID().slice(0, 8)}`,
        kind: "TRUCK",
        make: "Tata",
        model: "LPK",
        year: 2020,
        acquiredAt: new Date("2020-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    const schedOnOther = await prisma.serviceSchedule.create({
      data: {
        vehicleId: otherVehicle.id,
        name: "Oil",
        intervalType: "DISTANCE_KM",
        intervalValue: 5000,
        lastServiceAt: new Date("2026-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    await expect(
      controller.create(
        {
          vehicleId,
          performedAt: new Date("2026-02-01T00:00:00Z"),
          serviceScheduleId: schedOnOther.id,
        },
        fakeRequest,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("update returns the updated row; unknown id → NotFoundException (404)", async () => {
    const before = await service.create(
      { vehicleId, performedAt: new Date("2026-02-01T00:00:00Z") },
      adminId,
    );
    const after = await controller.update(before.id, { notes: "Replaced filter" });
    expect(after.notes).toBe("Replaced filter");
    await expect(controller.update("nonexistent-id", { notes: "x" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test("remove deletes the row (204); unknown id → NotFoundException (404)", async () => {
    const created = await service.create(
      { vehicleId, performedAt: new Date("2026-02-01T00:00:00Z") },
      adminId,
    );
    expect(await controller.remove(created.id)).toBeUndefined();
    expect(await prisma.serviceRecord.findUnique({ where: { id: created.id } })).toBeNull();
    await expect(controller.remove("nonexistent-id")).rejects.toBeInstanceOf(NotFoundException);
  });
});
