import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TrackerStatus, UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TrackersController } from "../src/modules/telematics/trackers.controller";
import {
  CreateTrackerSchema,
  ListTrackersQuerySchema,
  UpdateTrackerSchema,
} from "../src/modules/telematics/trackers.schemas";
import { TrackersService } from "../src/modules/telematics/trackers.service";
import { resetDb } from "./db";
import { randomImei, seedTrackerDevice } from "./fixtures/tracker-device";
import { seedVehicle } from "./fixtures/trip";

// Controller-level tests for the TrackerDevice register (ADR-0042 M4). Three
// layers, mirroring geofences.controller.test.ts:
//
//   1. Pipe layer — ZodValidationPipe over the three schemas, pure code.
//      Pins .strict() unknown-key rejection (incl. server-controlled
//      createdById / id), the 15-digit IMEI gate, the sortBy whitelist, and
//      the RETIRED-while-assigned superRefine on create.
//   2. Controller integration (real Prisma, guards overridden) — list/detail
//      shape + 404, create fills createdById from the session, PATCH
//      assign/unassign round-trip. There is NO delete handler (ADR-0042
//      defines none) — pinned by reflection.
//   3. RBAC HTTP boundary (REAL AuthGuard + RolesGuard chain) — the
//      trackers:read / trackers:write split: reads ADMIN + OFFICE_STAFF,
//      writes ADMIN-only, DRIVER 403 everywhere, anonymous 401 (401 ≠ 403).

const VALID_IMEI = "350000000000042";

// ───────────────────────────────────────────────────────────────────────────
// 1 — pipe layer
// ───────────────────────────────────────────────────────────────────────────

describe("ListTrackersQuerySchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(ListTrackersQuerySchema);

  test("bogus query key → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ statsu: "ACTIVE" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    expect(() => pipe.transform({ status: "BROKEN" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy (simMsisdn) → BadRequestException (Tier-3 ordering defense)", () => {
    expect(() => pipe.transform({ sortBy: "simMsisdn" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy (createdById) → BadRequestException", () => {
    expect(() => pipe.transform({ sortBy: "createdById" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException", () => {
    expect(() => pipe.transform({ take: "5000" })).toThrow(BadRequestException);
  });

  test("a non-cuid vehicleId filter → BadRequestException", () => {
    expect(() => pipe.transform({ vehicleId: "not-a-cuid" })).toThrow(BadRequestException);
  });

  test("valid query parses (status csv → array, strings → numbers)", () => {
    const result = pipe.transform({
      status: "ACTIVE,SPARE",
      sortBy: "imei",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual([TrackerStatus.ACTIVE, TrackerStatus.SPARE]);
    expect(result.sortBy).toBe("imei");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → all-undefined (controller/service apply defaults)", () => {
    const result = pipe.transform({});
    expect(result.status).toBeUndefined();
    expect(result.vehicleId).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
  });
});

describe("CreateTrackerSchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(CreateTrackerSchema);

  test("server-controlled createdById in the body → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ imei: VALID_IMEI, createdById: "smuggled" })).toThrow(
      BadRequestException,
    );
  });

  test("a client-supplied id → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ imei: VALID_IMEI, id: "smuggled" })).toThrow(BadRequestException);
  });

  test("missing imei → BadRequestException", () => {
    expect(() => pipe.transform({ label: "no imei" })).toThrow(BadRequestException);
  });

  // ── the 15-digit IMEI gate: a mistyped IMEI must fail HERE, not silently
  //    never match a forward (ADR-0042 c9) ──

  test("14-digit imei → BadRequestException", () => {
    expect(() => pipe.transform({ imei: "35000000000001" })).toThrow(BadRequestException);
  });

  test("16-digit imei → BadRequestException", () => {
    expect(() => pipe.transform({ imei: "3500000000000012" })).toThrow(BadRequestException);
  });

  test("imei with separators → BadRequestException", () => {
    expect(() => pipe.transform({ imei: "35-0000-0000-0001" })).toThrow(BadRequestException);
  });

  test("RETIRED with a vehicleId on create → BadRequestException (the lifecycle superRefine)", () => {
    expect(() =>
      pipe.transform({
        imei: VALID_IMEI,
        status: "RETIRED",
        vehicleId: "ctracker00000000000000tst",
      }),
    ).toThrow(BadRequestException);
  });

  test("valid minimal create parses (imei only)", () => {
    const parsed = pipe.transform({ imei: VALID_IMEI });
    expect(parsed.imei).toBe(VALID_IMEI);
    expect(parsed.status).toBeUndefined(); // DB default SPARE applies
  });

  test("valid full create parses; installedAt coerces to a Date", () => {
    const parsed = pipe.transform({
      imei: VALID_IMEI,
      label: "FMC920 unit 1",
      simMsisdn: "+977 9800000000",
      status: "ACTIVE",
      vehicleId: "ctracker00000000000000tst",
      installedAt: "2026-07-01",
    });
    expect(parsed.status).toBe("ACTIVE");
    expect(parsed.installedAt).toBeInstanceOf(Date);
  });
});

describe("UpdateTrackerSchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(UpdateTrackerSchema);

  test("empty body → BadRequestException (the at-least-one-field refine)", () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });

  test("bogus key (id) → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ id: "smuggled" })).toThrow(BadRequestException);
  });

  test("explicit vehicleId null parses (unassign)", () => {
    expect(pipe.transform({ vehicleId: null }).vehicleId).toBeNull();
  });

  test("a {status: RETIRED}-only PATCH parses (the invariant is a merged-shape/service concern)", () => {
    // The Update schema deliberately does NOT superRefine the lifecycle: a
    // partial body may omit `vehicleId`, so the rule can only be decided
    // against the MERGED shape (the service's job — covered in
    // trackers.service.test.ts). This pins that design.
    expect(pipe.transform({ status: "RETIRED" }).status).toBe("RETIRED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2 — controller integration (real Prisma, guards overridden)
// ───────────────────────────────────────────────────────────────────────────

describe("TrackersController (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: TrackersController;
  let adminId: string;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [TrackersController],
      providers: [
        TrackersService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(TrackersController);
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
    // Post-#175 rule: a fake session must carry an explicit role — a
    // role-less session coerces to DRIVER (fail-closed).
    fakeRequest = {
      session: { user: { id: adminId, role: UserRole.ADMIN } },
    } as unknown as AuthenticatedRequest;
  });

  test("list returns the response shape { items, total, skip, take, sortBy, sortDir }", async () => {
    await seedTrackerDevice(prisma, { createdById: adminId, label: "Listed unit" });
    const response = await controller.list({ sortBy: "imei", sortDir: "asc", skip: 0, take: 10 });
    expect(response).toMatchObject({ total: 1, skip: 0, take: 10, sortBy: "imei", sortDir: "asc" });
    expect(response.items[0]?.label).toBe("Listed unit");
  });

  test("list items carry the assigned vehicle's registration (no web-side N+1)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    await seedTrackerDevice(prisma, { createdById: adminId, vehicleId: vehicle.id });
    const response = await controller.list({});
    expect(response.items[0]?.vehicle?.registrationNumber).toBe(vehicle.registrationNumber);
  });

  test("getById returns the tracker; unknown id → NotFoundException with the id named", async () => {
    const tracker = await seedTrackerDevice(prisma, { createdById: adminId });
    const fetched = await controller.getById(tracker.id);
    expect(fetched.id).toBe(tracker.id);

    try {
      await controller.getById("nonexistent-tracker-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-tracker-id");
    }
  });

  test("create persists with createdById from the session, never the body", async () => {
    const created = await controller.create({ imei: randomImei() }, fakeRequest);
    expect(created.id).toBeTruthy();
    expect(created.createdById).toBe(adminId);
    expect(created.status).toBe(TrackerStatus.SPARE);
  });

  test("update assigns and unassigns; unknown id → NotFoundException", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const tracker = await seedTrackerDevice(prisma, { createdById: adminId });

    const assigned = await controller.update(tracker.id, {
      vehicleId: vehicle.id,
      status: "ACTIVE",
    });
    expect(assigned.vehicleId).toBe(vehicle.id);

    const unassigned = await controller.update(tracker.id, { vehicleId: null, status: "SPARE" });
    expect(unassigned.vehicleId).toBeNull();

    try {
      await controller.update("nonexistent-id", { label: "X" });
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
    }
  });

  test("there is NO delete handler (ADR-0042 defines none — RETIRE is the lifecycle end)", () => {
    expect(
      (controller as unknown as Record<string, unknown>).remove ??
        (controller as unknown as Record<string, unknown>).delete,
    ).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3 — RBAC HTTP boundary (real AuthGuard + RolesGuard chain, ADR-0042 c6)
// ───────────────────────────────────────────────────────────────────────────

// AUTH stub identical to the geofences precedent: `x-test-role` drives the
// caller's role (an EXPLICIT role — the fail-closed coercion would demote a
// role-less session to DRIVER); no header → null session → 401.
const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
      return {
        session: {
          id: "sess_test",
          token: "tok_test",
          userId: "user_test",
          expiresAt: new Date(Date.now() + 60_000),
        },
        user: { id: "user_test", email: "user@fleetco.test", name: "Test", role },
      };
    },
  },
};

describe("Trackers RBAC (trackers:read / trackers:write, ADR-0042 c6)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let seededId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TrackersController],
      providers: [
        TrackersService,
        PrismaService,
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);

    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Seed the session user (so ADMIN writes satisfy the createdById FK →
    // real 201/200) plus one tracker for read/patch.
    const prisma = moduleRef.get(PrismaService);
    await resetDb(prisma);
    await prisma.user.create({
      data: { id: "user_test", email: "user@fleetco.test", name: "Test" },
    });
    seededId = (await seedTrackerDevice(prisma, { createdById: "user_test" })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function status(
    method: string,
    path: string,
    role?: string,
    body?: unknown,
  ): Promise<number> {
    const headers: Record<string, string> = {};
    if (role !== undefined) headers["x-test-role"] = role;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res.status;
  }

  const LIST = "/api/v1/telematics/trackers";
  const detail = (): string => `${LIST}/${seededId}`;

  // ── read routes: trackers:read (ADMIN + OFFICE_STAFF) ──

  test("list (read): ADMIN → 200", async () => {
    expect(await status("GET", LIST, UserRole.ADMIN)).toBe(200);
  });

  test("list (read): OFFICE_STAFF → 200 (the positive half of the split)", async () => {
    expect(await status("GET", LIST, UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("list (read): DRIVER → 403", async () => {
    expect(await status("GET", LIST, UserRole.DRIVER)).toBe(403);
  });

  test("list (read): anonymous → 401 from AuthGuard, NOT 403", async () => {
    expect(await status("GET", LIST)).toBe(401);
  });

  test("detail (read): OFFICE_STAFF → 200; DRIVER → 403; anonymous → 401", async () => {
    expect(await status("GET", detail(), UserRole.OFFICE_STAFF)).toBe(200);
    expect(await status("GET", detail(), UserRole.DRIVER)).toBe(403);
    expect(await status("GET", detail())).toBe(401);
  });

  // ── write routes: trackers:write (ADMIN only) ──

  test("create (write): ADMIN → 201", async () => {
    expect(await status("POST", LIST, UserRole.ADMIN, { imei: randomImei() })).toBe(201);
  });

  test("create (write): OFFICE_STAFF → 403 (authed but lacks trackers:write)", async () => {
    expect(await status("POST", LIST, UserRole.OFFICE_STAFF, { imei: randomImei() })).toBe(403);
  });

  test("create (write): DRIVER → 403", async () => {
    expect(await status("POST", LIST, UserRole.DRIVER, { imei: randomImei() })).toBe(403);
  });

  test("create (write): anonymous → 401", async () => {
    expect(await status("POST", LIST, undefined, { imei: randomImei() })).toBe(401);
  });

  test("update (write): ADMIN → 200; OFFICE_STAFF and DRIVER → 403", async () => {
    expect(await status("PATCH", detail(), UserRole.ADMIN, { label: "Renamed" })).toBe(200);
    expect(await status("PATCH", detail(), UserRole.OFFICE_STAFF, { label: "Nope" })).toBe(403);
    expect(await status("PATCH", detail(), UserRole.DRIVER, { label: "Nope" })).toBe(403);
  });

  test("DELETE on the register → 404 (no route exists to gate)", async () => {
    expect(await status("DELETE", detail(), UserRole.ADMIN)).toBe(404);
  });
});
