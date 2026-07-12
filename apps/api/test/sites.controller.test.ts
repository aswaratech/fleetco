import type { AddressInfo } from "node:net";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type INestApplication,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { SiteKind, TripStatus, UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { SitesController } from "../src/modules/sites/sites.controller";
import {
  CreateSiteSchema,
  ListSitesQuerySchema,
  UpdateSiteSchema,
} from "../src/modules/sites/sites.schemas";
import { SitesService } from "../src/modules/sites/sites.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { seedSite } from "./fixtures/site";
import { seedDriver, seedUser, seedVehicle } from "./fixtures/trip";

// Controller-level tests for the Sites slice (ADR-0047 W3). Three layers,
// mirroring customers.controller.test.ts + geofences.controller.test.ts:
//
//   1. Pipe layer — ZodValidationPipe over the three schemas, pure code (no
//      server). Pins .strict() unknown-key rejection (incl. server-controlled
//      createdById / db-generated geometry / id), the sortBy whitelist, the
//      kind csv filter, and the load-bearing latitude/longitude range gates.
//   2. Controller integration (real Prisma, guards overridden) — list/detail
//      shape + 404, create returns the row with createdById from the session
//      (and the DB derives the geometry from the floats), update, delete, and
//      the P2003 → 409 delete-blocker naming the referencing-trip count.
//   3. RBAC HTTP boundary (REAL AuthGuard + RolesGuard chain) — the COARSE
//      sites:* token: ADMIN and OFFICE_STAFF alike get full CRUD (contrast the
//      geofences read/write split), DRIVER → 403, anonymous → 401 (401 ≠ 403).

// ───────────────────────────────────────────────────────────────────────────
// 1 — pipe layer
// ───────────────────────────────────────────────────────────────────────────

describe("ListSitesQuerySchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(ListSitesQuerySchema);

  test("bogus query key (e.g. ?kidn=CRUSHER) → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ kidn: "CRUSHER" })).toThrow(BadRequestException);
  });

  test("invalid kind enum value → BadRequestException", () => {
    expect(() => pipe.transform({ kind: "WAREHOUSE" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy (latitude) → BadRequestException", () => {
    expect(() => pipe.transform({ sortBy: "latitude" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy (contactPhone) → BadRequestException (info-disclosure defense on Tier-2)", () => {
    // Sorting by a Tier-2 contact field would leak ordering signal; the
    // whitelist is name / createdAt only. Same defense every list schema applies.
    expect(() => pipe.transform({ sortBy: "contactPhone" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException", () => {
    expect(() => pipe.transform({ take: "5000" })).toThrow(BadRequestException);
  });

  test("skip below zero → BadRequestException", () => {
    expect(() => pipe.transform({ skip: "-1" })).toThrow(BadRequestException);
  });

  test("valid query parses (kind csv → array, strings → numbers)", () => {
    const result = pipe.transform({
      kind: "CRUSHER,DELIVERY_SITE",
      sortBy: "name",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.kind).toEqual([SiteKind.CRUSHER, SiteKind.DELIVERY_SITE]);
    expect(result.sortBy).toBe("name");
    expect(result.sortDir).toBe("asc");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → all-undefined (controller/service apply defaults)", () => {
    const result = pipe.transform({});
    expect(result.kind).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });
});

describe("CreateSiteSchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(CreateSiteSchema);

  const validSite = { name: "Kalimati Crusher", kind: "CRUSHER", latitude: 27.7, longitude: 85.3 };

  test("server-controlled createdById in the body → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ ...validSite, createdById: "smuggled" })).toThrow(
      BadRequestException,
    );
  });

  test("database-derived geometry in the body → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ ...validSite, geometry: "POINT(85.3 27.7)" })).toThrow(
      BadRequestException,
    );
  });

  test("a client-supplied id → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ ...validSite, id: "smuggled" })).toThrow(BadRequestException);
  });

  test("missing name → BadRequestException", () => {
    expect(() => pipe.transform({ kind: "CRUSHER", latitude: 27.7, longitude: 85.3 })).toThrow(
      BadRequestException,
    );
  });

  test("missing kind → BadRequestException", () => {
    expect(() => pipe.transform({ name: "X", latitude: 27.7, longitude: 85.3 })).toThrow(
      BadRequestException,
    );
  });

  test("missing latitude → BadRequestException", () => {
    expect(() => pipe.transform({ name: "X", kind: "CRUSHER", longitude: 85.3 })).toThrow(
      BadRequestException,
    );
  });

  test("missing longitude → BadRequestException", () => {
    expect(() => pipe.transform({ name: "X", kind: "CRUSHER", latitude: 27.7 })).toThrow(
      BadRequestException,
    );
  });

  test("invalid kind enum → BadRequestException", () => {
    expect(() =>
      pipe.transform({ name: "X", kind: "WAREHOUSE", latitude: 27.7, longitude: 85.3 }),
    ).toThrow(BadRequestException);
  });

  // ── the load-bearing latitude / longitude range gates ──

  test("latitude above 90 → BadRequestException", () => {
    expect(() => pipe.transform({ ...validSite, latitude: 100 })).toThrow(BadRequestException);
  });

  test("latitude below -90 → BadRequestException", () => {
    expect(() => pipe.transform({ ...validSite, latitude: -100 })).toThrow(BadRequestException);
  });

  test("longitude above 180 → BadRequestException", () => {
    expect(() => pipe.transform({ ...validSite, longitude: 200 })).toThrow(BadRequestException);
  });

  test("longitude below -180 → BadRequestException", () => {
    expect(() => pipe.transform({ ...validSite, longitude: -200 })).toThrow(BadRequestException);
  });

  test("a non-numeric latitude (string) → BadRequestException", () => {
    expect(() => pipe.transform({ ...validSite, latitude: "27.7" })).toThrow(BadRequestException);
  });

  test("valid minimal body (name + kind + lat + lon) parses through", () => {
    const parsed = pipe.transform(validSite);
    expect(parsed.name).toBe("Kalimati Crusher");
    expect(parsed.kind).toBe("CRUSHER");
    expect(parsed.latitude).toBe(27.7);
    expect(parsed.longitude).toBe(85.3);
    expect(parsed.address).toBeUndefined();
  });

  test("valid full body parses through with all fields", () => {
    const parsed = pipe.transform({
      name: "Pokhara Site",
      kind: "DELIVERY_SITE",
      latitude: 28.2096,
      longitude: 83.9856,
      address: "Lakeside, Pokhara",
      contactName: "Ram Bahadur",
      contactPhone: "+977-9800000000",
    });
    expect(parsed.kind).toBe("DELIVERY_SITE");
    expect(parsed.address).toBe("Lakeside, Pokhara");
    expect(parsed.contactName).toBe("Ram Bahadur");
    expect(parsed.contactPhone).toBe("+977-9800000000");
  });

  test("nullable optional fields accept null explicitly", () => {
    const parsed = pipe.transform({
      ...validSite,
      address: null,
      contactName: null,
      contactPhone: null,
    });
    expect(parsed.address).toBeNull();
    expect(parsed.contactName).toBeNull();
    expect(parsed.contactPhone).toBeNull();
  });

  test("boundary latitude/longitude (exactly ±90 / ±180) parse through", () => {
    // The bounds are inclusive; the poles and the antimeridian are valid pins.
    const parsed = pipe.transform({ name: "Edge", kind: "OTHER", latitude: 90, longitude: -180 });
    expect(parsed.latitude).toBe(90);
    expect(parsed.longitude).toBe(-180);
  });
});

describe("UpdateSiteSchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(UpdateSiteSchema);

  test("empty body → BadRequestException (the at-least-one-field refine)", () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });

  test("bogus key (id) → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ id: "smuggled" })).toThrow(BadRequestException);
  });

  test("single-field PATCH (just name) parses through", () => {
    expect(pipe.transform({ name: "Renamed" }).name).toBe("Renamed");
  });

  test("a re-pinned latitude parses; an out-of-range one is still rejected on PATCH", () => {
    // .partial() keeps the range validators, so a PATCH cannot smuggle an
    // impossible pin past the schema.
    expect(pipe.transform({ latitude: 28.0 }).latitude).toBe(28.0);
    expect(() => pipe.transform({ latitude: 91 })).toThrow(BadRequestException);
  });

  test("explicit contactName: null is accepted (the 'clear' branch)", () => {
    expect(pipe.transform({ contactName: null }).contactName).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2 — controller integration (real Prisma, guards overridden)
// ───────────────────────────────────────────────────────────────────────────

describe("SitesController (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: SitesController;
  let adminId: string;
  let fakeRequest: AuthenticatedRequest;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [SitesController],
      providers: [
        SitesService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      // Both guards pass-through here: this describe tests handler wiring, not
      // RBAC (the real guard chain is exercised in the RBAC describe below).
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(SitesController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    fakeRequest = { session: { user: { id: adminId } } } as unknown as AuthenticatedRequest;
  });

  test("list returns the response shape { items, total, skip, take, sortBy, sortDir }", async () => {
    await seedSite(prisma, { createdById: adminId, name: "Listed Crusher" });
    const response = await controller.list({ sortBy: "name", sortDir: "asc", skip: 0, take: 10 });
    expect(response).toMatchObject({ total: 1, skip: 0, take: 10, sortBy: "name", sortDir: "asc" });
    expect(response.items[0]?.name).toBe("Listed Crusher");
  });

  test("empty query → controller defaults (createdAt desc, skip 0, take 20)", async () => {
    await seedSite(prisma, { createdById: adminId });
    const response = await controller.list({});
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("the kind filter narrows the result set", async () => {
    await seedSite(prisma, { createdById: adminId, name: "A Crusher", kind: SiteKind.CRUSHER });
    await seedSite(prisma, { createdById: adminId, name: "A Site", kind: SiteKind.DELIVERY_SITE });
    await seedSite(prisma, { createdById: adminId, name: "A Pit", kind: SiteKind.PIT });

    const onlyCrushers = await controller.list({ kind: [SiteKind.CRUSHER] });
    expect(onlyCrushers.total).toBe(1);
    expect(onlyCrushers.items[0]?.name).toBe("A Crusher");

    const crushersAndPits = await controller.list({ kind: [SiteKind.CRUSHER, SiteKind.PIT] });
    expect(crushersAndPits.total).toBe(2);
  });

  test("sort by name asc orders alphabetically", async () => {
    await seedSite(prisma, { createdById: adminId, name: "Zebra Yard" });
    await seedSite(prisma, { createdById: adminId, name: "Alpha Yard" });
    const response = await controller.list({ sortBy: "name", sortDir: "asc" });
    expect(response.items.map((s) => s.name)).toEqual(["Alpha Yard", "Zebra Yard"]);
  });

  test("getById returns the site when present", async () => {
    const site = await seedSite(prisma, { createdById: adminId, name: "Detail Crusher" });
    const fetched = await controller.getById(site.id);
    expect(fetched.id).toBe(site.id);
    expect(fetched.name).toBe("Detail Crusher");
  });

  test("getById of an unknown id → NotFoundException (404) with the id named", async () => {
    try {
      await controller.getById("nonexistent-site-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-site-id");
    }
  });

  test("create persists a Site with createdById from the session, and the DB derives the geometry", async () => {
    const created = await controller.create(
      { name: "Created Crusher", kind: "CRUSHER", latitude: 27.7172, longitude: 85.324 },
      fakeRequest,
    );
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("Created Crusher");
    expect(created.kind).toBe(SiteKind.CRUSHER);
    // createdById comes from the session, never the body.
    expect(created.createdById).toBe(adminId);
    expect(created.latitude).toBeCloseTo(27.7172, 6);
    expect(created.longitude).toBeCloseTo(85.324, 6);

    // The generated geometry(Point, 4326) column derives from the floats the
    // service wrote — ST_X = longitude, ST_Y = latitude (the ST_MakePoint(lon,
    // lat) order). Prisma cannot select the Unsupported column, so read it via
    // raw SQL, the same idiom the hybrid representation confines raw SQL to.
    const rows = await prisma.$queryRaw<{ lon: number; lat: number; srid: number }[]>`
      SELECT ST_X("geometry") AS lon, ST_Y("geometry") AS lat, ST_SRID("geometry") AS srid
      FROM "site"
      WHERE "id" = ${created.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].lon).toBeCloseTo(85.324, 6);
    expect(rows[0].lat).toBeCloseTo(27.7172, 6);
    expect(Number(rows[0].srid)).toBe(4326);
  });

  test("create stores optional contact fields (Tier-2) when supplied", async () => {
    const created = await controller.create(
      {
        name: "Contacted Site",
        kind: "DELIVERY_SITE",
        latitude: 28.2,
        longitude: 83.98,
        address: "Lakeside",
        contactName: "Sita Rai",
        contactPhone: "+977-9812345678",
      },
      fakeRequest,
    );
    expect(created.address).toBe("Lakeside");
    expect(created.contactName).toBe("Sita Rai");
    expect(created.contactPhone).toBe("+977-9812345678");
  });

  test("update returns the updated site; re-pinning moves the derived geometry", async () => {
    const site = await seedSite(prisma, {
      createdById: adminId,
      name: "Before",
      latitude: 27.7,
      longitude: 85.3,
    });
    const updated = await controller.update(site.id, {
      name: "After",
      latitude: 28.2096,
      longitude: 83.9856,
    });
    expect(updated.name).toBe("After");
    expect(updated.latitude).toBeCloseTo(28.2096, 6);

    // The generated geometry follows the re-pinned floats (it is derived, not
    // stored independently — it cannot drift).
    const rows = await prisma.$queryRaw<{ lon: number; lat: number }[]>`
      SELECT ST_X("geometry") AS lon, ST_Y("geometry") AS lat FROM "site" WHERE "id" = ${site.id}
    `;
    expect(rows[0].lon).toBeCloseTo(83.9856, 6);
    expect(rows[0].lat).toBeCloseTo(28.2096, 6);
  });

  test("update of an unknown id → NotFoundException", async () => {
    try {
      await controller.update("nonexistent-id", { name: "X" });
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
    }
  });

  test("update can clear an optional contact field with an explicit null", async () => {
    const site = await seedSite(prisma, {
      createdById: adminId,
      contactName: "Old Contact",
      contactPhone: "+977-9800000000",
    });
    const updated = await controller.update(site.id, { contactName: null });
    expect(updated.contactName).toBeNull();
    // An unmentioned field is left alone (diff-PATCH semantics).
    expect(updated.contactPhone).toBe("+977-9800000000");
  });

  test("remove deletes the row (204/void); unknown id → NotFoundException", async () => {
    const site = await seedSite(prisma, { createdById: adminId });
    const result = await controller.remove(site.id);
    expect(result).toBeUndefined();
    expect(await prisma.site.findUnique({ where: { id: site.id } })).toBeNull();

    try {
      await controller.remove("nonexistent-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
    }
  });

  // ── the delete-blocker (ADR-0047 c4): P2003 → 409 naming the trip count ──

  test("remove of a Site referenced by ONE trip → ConflictException naming the count (singular)", async () => {
    const site = await seedSite(prisma, { createdById: adminId, name: "Referenced Crusher" });
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId);
    await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.OFFERED,
        pickupSiteId: site.id,
      },
    });

    try {
      await controller.remove(site.id);
      throw new Error("expected ConflictException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      const message = (error as ConflictException).message;
      expect(message).toBe("Cannot delete site: 1 trip reference this site.");
    }

    // The site survives the blocked delete (Restrict prevented it).
    expect(await prisma.site.findUnique({ where: { id: site.id } })).not.toBeNull();
  });

  test("remove of a Site referenced by TWO trips (as pickup + drop-off) → count is plural", async () => {
    // Counts DISTINCT referencing trips across BOTH FK columns — one trip using
    // the site as pickup, another as drop-off, so the OR in the count query and
    // the 'trips' plural arm are both exercised.
    const site = await seedSite(prisma, { createdById: adminId });
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId);
    await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.OFFERED,
        pickupSiteId: site.id,
      },
    });
    await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.OFFERED,
        dropoffSiteId: site.id,
      },
    });

    try {
      await controller.remove(site.id);
      throw new Error("expected ConflictException");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        "Cannot delete site: 2 trips reference this site.",
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3 — RBAC HTTP boundary (real AuthGuard + RolesGuard chain, ADR-0047 c4/c10)
// ───────────────────────────────────────────────────────────────────────────

// AUTH stub identical to geofences.controller.test.ts: AuthGuard calls
// getSession({ headers }); the `x-test-role` header drives the caller's role,
// so one app instance serves every case. No header → null session → 401. The
// session user id is "user_test" — seeded below so write handlers (which fill
// createdById from the session) satisfy the FK and return real success codes.
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

describe("Sites RBAC (coarse sites:*, ADR-0047 c4/c10)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let seededId: string;
  let deletableByOffice: string;
  let deletableByAdmin: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SitesController],
      providers: [
        SitesService,
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

    // Seed the session user (so write handlers satisfy the createdById FK →
    // real 201/200/204) plus three sites: one for read/patch, two to delete
    // (one consumed by OFFICE_STAFF, one by ADMIN — coarse token: both roles
    // may delete).
    const prisma = moduleRef.get(PrismaService);
    await resetDb(prisma);
    await prisma.user.create({
      data: { id: "user_test", email: "user@fleetco.test", name: "Test" },
    });
    seededId = (await seedSite(prisma, { createdById: "user_test", name: "RBAC Crusher" })).id;
    deletableByOffice = (await seedSite(prisma, { createdById: "user_test", name: "Del A" })).id;
    deletableByAdmin = (await seedSite(prisma, { createdById: "user_test", name: "Del B" })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  // Issue a request and return the HTTP status. `role` undefined → no header →
  // 401 path. A body (for POST/PATCH) is sent as JSON.
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

  const LIST = "/api/v1/sites";
  const detail = (): string => `/api/v1/sites/${seededId}`;
  const VALID_BODY = { name: "New Depot", kind: "DEPOT", latitude: 27.7, longitude: 85.3 };

  // ── read routes: sites:* (ADMIN + OFFICE_STAFF) ──

  test("list: ADMIN → 200", async () => {
    expect(await status("GET", LIST, UserRole.ADMIN)).toBe(200);
  });

  test("list: OFFICE_STAFF → 200", async () => {
    expect(await status("GET", LIST, UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("list: DRIVER (does not hold sites:*) → 403", async () => {
    expect(await status("GET", LIST, UserRole.DRIVER)).toBe(403);
  });

  test("list: anonymous → 401 from AuthGuard, NOT 403", async () => {
    expect(await status("GET", LIST)).toBe(401);
  });

  test("detail: ADMIN → 200", async () => {
    expect(await status("GET", detail(), UserRole.ADMIN)).toBe(200);
  });

  test("detail: OFFICE_STAFF → 200", async () => {
    expect(await status("GET", detail(), UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("detail: anonymous → 401", async () => {
    expect(await status("GET", detail())).toBe(401);
  });

  // ── write routes: the coarse token means OFFICE_STAFF writes too ──

  test("create: ADMIN → 201", async () => {
    expect(await status("POST", LIST, UserRole.ADMIN, VALID_BODY)).toBe(201);
  });

  test("create: OFFICE_STAFF → 201 (coarse token — the office does dispatch data entry)", async () => {
    expect(await status("POST", LIST, UserRole.OFFICE_STAFF, VALID_BODY)).toBe(201);
  });

  test("create: DRIVER → 403", async () => {
    expect(await status("POST", LIST, UserRole.DRIVER, VALID_BODY)).toBe(403);
  });

  test("create: anonymous → 401", async () => {
    expect(await status("POST", LIST, undefined, VALID_BODY)).toBe(401);
  });

  test("update: ADMIN → 200", async () => {
    expect(await status("PATCH", detail(), UserRole.ADMIN, { name: "Renamed A" })).toBe(200);
  });

  test("update: OFFICE_STAFF → 200", async () => {
    expect(await status("PATCH", detail(), UserRole.OFFICE_STAFF, { name: "Renamed B" })).toBe(200);
  });

  test("update: DRIVER → 403", async () => {
    expect(await status("PATCH", detail(), UserRole.DRIVER, { name: "Nope" })).toBe(403);
  });

  // ── delete: coarse token, so BOTH roles may delete; the blocked cases run
  //    first (they do not consume a row), then the two real 204 deletes ──

  test("delete: DRIVER → 403 (blocked before the handler)", async () => {
    expect(await status("DELETE", `/api/v1/sites/${deletableByAdmin}`, UserRole.DRIVER)).toBe(403);
  });

  test("delete: anonymous → 401", async () => {
    expect(await status("DELETE", `/api/v1/sites/${deletableByAdmin}`)).toBe(401);
  });

  test("delete: OFFICE_STAFF → 204 (coarse token — the office may delete a site)", async () => {
    expect(
      await status("DELETE", `/api/v1/sites/${deletableByOffice}`, UserRole.OFFICE_STAFF),
    ).toBe(204);
  });

  test("delete: ADMIN → 204", async () => {
    expect(await status("DELETE", `/api/v1/sites/${deletableByAdmin}`, UserRole.ADMIN)).toBe(204);
  });
});
