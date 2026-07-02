import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  type INestApplication,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { ServiceSchedulesController } from "../src/modules/maintenance/service-schedules.controller";
import { ServiceSchedulesService } from "../src/modules/maintenance/service-schedules.service";
import {
  CreateServiceScheduleSchema,
  ListServiceSchedulesQuerySchema,
  UpdateServiceScheduleSchema,
} from "../src/modules/maintenance/service-schedules.schemas";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Two-layer structure mirrors customers.controller.test.ts:
//   1. Schema/pipe layer — ZodValidationPipe over the three schemas, tested
//      directly (pure code, no Nest boot): the .strict() defense, the
//      sortBy-whitelist / enum / cuid / pagination-ceiling defenses, and the
//      string→typed coercions.
//   2. Controller layer — real controller + service + PrismaService, AuthGuard
//      overridden to pass-through, AUTH stubbed: the { items, total, skip,
//      take, sortBy, sortDir } response shape, 404 mapping, the create/update
//      name-conflict → 409 with field token, and the delete surfaces.

describe("ServiceSchedulesController list-query schema (B3 contract)", () => {
  const pipe = new ZodValidationPipe(ListServiceSchedulesQuerySchema);

  test("bogus query key → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ staus: "ACTIVE" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    expect(() => pipe.transform({ status: "PENDING" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy → BadRequestException (intervalValue is not sortable)", () => {
    expect(() => pipe.transform({ sortBy: "intervalValue" })).toThrow(BadRequestException);
  });

  test("sortBy=createdById is rejected (information-disclosure defense)", () => {
    expect(() => pipe.transform({ sortBy: "createdById" })).toThrow(BadRequestException);
  });

  test("non-cuid vehicleId filter → BadRequestException", () => {
    expect(() => pipe.transform({ vehicleId: "not-a-cuid" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException with field-named message", () => {
    try {
      pipe.transform({ take: "999" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message.toLowerCase()).toContain("take");
    }
  });

  test("skip below zero → BadRequestException", () => {
    expect(() => pipe.transform({ skip: "-1" })).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (csv → array, string → number)", () => {
    const result = pipe.transform({
      status: "ACTIVE,INACTIVE",
      sortBy: "name",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual(["ACTIVE", "INACTIVE"]);
    expect(result.sortBy).toBe("name");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → undefined fields (defaults applied at controller)", () => {
    const result = pipe.transform({});
    expect(result.status).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });
});

describe("ServiceSchedulesController write-path schemas (B3 contract)", () => {
  describe("CreateServiceScheduleSchema", () => {
    const createPipe = new ZodValidationPipe(CreateServiceScheduleSchema);

    test("bogus body key (createdById) → BadRequestException (.strict())", () => {
      expect(() =>
        createPipe.transform({
          vehicleId: "ckvehicle00000000",
          name: "Oil",
          intervalType: "DISTANCE_KM",
          intervalValue: 5000,
          createdById: "smuggled",
        }),
      ).toThrow(BadRequestException);
    });

    test("missing required name → BadRequestException", () => {
      expect(() =>
        createPipe.transform({
          vehicleId: "ckvehicle00000000",
          intervalType: "DISTANCE_KM",
          intervalValue: 5000,
        }),
      ).toThrow(BadRequestException);
    });

    test("missing intervalType / intervalValue → BadRequestException", () => {
      expect(() => createPipe.transform({ vehicleId: "ckvehicle00000000", name: "Oil" })).toThrow(
        BadRequestException,
      );
    });

    test("invalid intervalType enum → BadRequestException", () => {
      expect(() =>
        createPipe.transform({
          vehicleId: "ckvehicle00000000",
          name: "Oil",
          intervalType: "DISTANCE_MILES",
          intervalValue: 5000,
        }),
      ).toThrow(BadRequestException);
    });

    test("non-integer / sub-1 intervalValue → BadRequestException", () => {
      expect(() =>
        createPipe.transform({
          vehicleId: "ckvehicle00000000",
          name: "Oil",
          intervalType: "DISTANCE_KM",
          intervalValue: 12.5,
        }),
      ).toThrow(BadRequestException);
      expect(() =>
        createPipe.transform({
          vehicleId: "ckvehicle00000000",
          name: "Oil",
          intervalType: "DISTANCE_KM",
          intervalValue: 0,
        }),
      ).toThrow(BadRequestException);
    });

    test("non-cuid vehicleId → BadRequestException", () => {
      expect(() =>
        createPipe.transform({
          vehicleId: "nope",
          name: "Oil",
          intervalType: "DISTANCE_KM",
          intervalValue: 5000,
        }),
      ).toThrow(BadRequestException);
    });

    test("valid minimal body parses; status undefined (service defaults it)", () => {
      const parsed = createPipe.transform({
        vehicleId: "ckvehicle00000000",
        name: "Oil change",
        intervalType: "DISTANCE_KM",
        intervalValue: 5000,
      });
      expect(parsed.name).toBe("Oil change");
      expect(parsed.intervalValue).toBe(5000);
      expect(parsed.status).toBeUndefined();
    });

    test("lastServiceAt is coerced to a Date; nullable anchors accept null", () => {
      const parsed = createPipe.transform({
        vehicleId: "ckvehicle00000000",
        name: "Oil",
        intervalType: "DISTANCE_KM",
        intervalValue: 5000,
        lastServiceAt: "2026-03-01",
        lastServiceOdometerKm: null,
        lastServiceEngineHours: null,
      });
      expect(parsed.lastServiceAt).toBeInstanceOf(Date);
      expect(parsed.lastServiceOdometerKm).toBeNull();
    });
  });

  describe("UpdateServiceScheduleSchema", () => {
    const updatePipe = new ZodValidationPipe(UpdateServiceScheduleSchema);

    test("empty body → BadRequestException (at-least-one-field refine)", () => {
      expect(() => updatePipe.transform({})).toThrow(BadRequestException);
    });

    test("bogus key (id) → BadRequestException", () => {
      expect(() => updatePipe.transform({ id: "smuggled" })).toThrow(BadRequestException);
    });

    test("immutable vehicleId is rejected (.strict())", () => {
      expect(() => updatePipe.transform({ vehicleId: "ckvehicle00000000" })).toThrow(
        BadRequestException,
      );
    });

    test("single-field PATCH parses; explicit description null accepted", () => {
      expect(updatePipe.transform({ name: "Renamed" }).name).toBe("Renamed");
      expect(updatePipe.transform({ description: null }).description).toBeNull();
    });
  });
});

describe("ServiceSchedulesController (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: ServiceSchedulesController;
  let service: ServiceSchedulesService;
  let adminId: string;
  let vehicleId: string;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [ServiceSchedulesController],
      providers: [
        ServiceSchedulesService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    service = module.get(ServiceSchedulesService);
    controller = module.get(ServiceSchedulesController);
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
        kind: "EXCAVATOR",
        make: "CAT",
        model: "320",
        year: 2021,
        acquiredAt: new Date("2021-01-01T00:00:00Z"),
        meterType: "ENGINE_HOURS",
        engineHoursStart: 0,
        engineHoursCurrent: 1000,
        createdById: adminId,
      },
    });
    vehicleId = vehicle.id;
    fakeRequest = { session: { user: { id: adminId } } } as unknown as AuthenticatedRequest;
  });

  test("list returns the { items, total, skip, take, sortBy, sortDir } shape", async () => {
    await controller.create(
      { vehicleId, name: "250h service", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      fakeRequest,
    );
    const response = await controller.list({ vehicleId, take: 10, sortBy: "name", sortDir: "asc" });
    expect(response).toMatchObject({ total: 1, skip: 0, take: 10, sortBy: "name", sortDir: "asc" });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.name).toBe("250h service");
  });

  test("empty query → controller defaults (createdAt desc, skip 0, take 20)", async () => {
    await controller.create(
      { vehicleId, name: "Annual", intervalType: "CALENDAR_DAYS", intervalValue: 365 },
      fakeRequest,
    );
    const response = await controller.list({});
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("getById returns the schedule; unknown id → NotFoundException (404)", async () => {
    const created = await controller.create(
      { vehicleId, name: "Oil", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      fakeRequest,
    );
    const fetched = await controller.getById(created.id);
    expect(fetched.id).toBe(created.id);

    try {
      await controller.getById("nonexistent-schedule-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-schedule-id");
    }
  });

  test("create persists with createdById from the session (HTTP 201 + body)", async () => {
    const created = await controller.create(
      { vehicleId, name: "500h hydraulic", intervalType: "ENGINE_HOURS", intervalValue: 5000 },
      fakeRequest,
    );
    expect(created.id).toBeTruthy();
    expect(created.createdById).toBe(adminId);
    // ENGINE_HOURS anchor seeded from the vehicle's current hours (1000).
    expect(created.lastServiceEngineHours).toBe(1000);
  });

  test("create with a duplicate name on the same vehicle → HTTP 409 with field 'name'", async () => {
    await controller.create(
      { vehicleId, name: "250h service", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      fakeRequest,
    );
    let thrown: unknown;
    try {
      await controller.create(
        { vehicleId, name: "250h service", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
        fakeRequest,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    const body = (thrown as HttpException).getResponse() as { field: string; message: string };
    expect(body.field).toBe("name");
    expect(body.message).toContain("250h service");
  });

  test("create with an ENGINE_HOURS schedule on an ODOMETER_KM vehicle → BadRequestException (400)", async () => {
    const truck = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA-${randomUUID().slice(0, 8)}`,
        kind: "TRUCK",
        make: "Tata",
        model: "LPK",
        year: 2020,
        acquiredAt: new Date("2020-01-01T00:00:00Z"),
        meterType: "ODOMETER_KM",
        createdById: adminId,
      },
    });
    await expect(
      controller.create(
        { vehicleId: truck.id, name: "Engine", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
        fakeRequest,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("update returns the updated row; unknown id → NotFoundException (404)", async () => {
    const before = await service.create(
      { vehicleId, name: "Oil", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      adminId,
    );
    const after = await controller.update(before.id, { intervalValue: 3000 });
    expect(after.intervalValue).toBe(3000);

    try {
      await controller.update("nonexistent-id", { intervalValue: 1 });
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-id");
    }
  });

  test("update to a colliding name → HTTP 409 with field 'name'", async () => {
    const a = await service.create(
      { vehicleId, name: "A svc", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      adminId,
    );
    await service.create(
      { vehicleId, name: "B svc", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      adminId,
    );
    let thrown: unknown;
    try {
      await controller.update(a.id, { name: "B svc" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(((thrown as HttpException).getResponse() as { field: string }).field).toBe("name");
  });

  test("remove deletes the row (204); unknown id → NotFoundException (404)", async () => {
    const created = await service.create(
      { vehicleId, name: "To delete", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      adminId,
    );
    expect(await controller.remove(created.id)).toBeUndefined();
    expect(await prisma.serviceSchedule.findUnique({ where: { id: created.id } })).toBeNull();

    try {
      await controller.remove("nonexistent-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
    }
  });

  test("remove blocked when a ServiceRecord references the schedule → ConflictException (409)", async () => {
    const schedule = await service.create(
      { vehicleId, name: "Referenced", intervalType: "ENGINE_HOURS", intervalValue: 2500 },
      adminId,
    );
    await prisma.serviceRecord.create({
      data: {
        vehicleId,
        serviceScheduleId: schedule.id,
        performedAt: new Date("2026-02-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    await expect(controller.remove(schedule.id)).rejects.toBeInstanceOf(ConflictException);
  });
});
