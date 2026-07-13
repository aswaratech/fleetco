import { getQueueToken } from "@nestjs/bullmq";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { TripStatus, UserRole } from "@prisma/client";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { GeofencesService } from "../src/modules/geofences/geofences.service";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { Logger } from "nestjs-pino";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TelematicsController } from "../src/modules/telematics/telematics.controller";
import {
  GeofenceStatusQuerySchema,
  ListPingsQuerySchema,
} from "../src/modules/telematics/telematics.schemas";
import { GPS_INGEST_QUEUE, TelematicsService } from "../src/modules/telematics/telematics.service";
import { resetDb } from "./db";
import { seedGeofence } from "./fixtures/geofence";
import { seedGpsPing } from "./fixtures/gps-ping";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// ───────────────────────────────────────────────────────────────────────────
// Part 1 — schema / pipe layer (no server). Pins the read-query contracts the
// endpoints validate before the handler runs: the raw-list pagination/sort
// bounds and the geofence circle-XOR-polygon rule + polygon parsing.
// ───────────────────────────────────────────────────────────────────────────

describe("ListPingsQuerySchema (raw trace list, pipe layer)", () => {
  const pipe = new ZodValidationPipe(ListPingsQuerySchema);

  test("valid query parses (dates coerced, take bounded)", () => {
    const parsed = pipe.transform({
      from: "2026-02-01",
      to: "2026-02-28",
      sortBy: "timestamp",
      sortDir: "asc",
      skip: "0",
      take: "50",
    });
    expect(parsed.from).toBeInstanceOf(Date);
    expect(parsed.to).toBeInstanceOf(Date);
    expect(parsed.take).toBe(50);
    expect(parsed.sortBy).toBe("timestamp");
  });

  test("an unknown query key → 400 (.strict())", () => {
    expect(() => pipe.transform({ form: "2026-02-01" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → 400 (not silently clamped)", () => {
    expect(() => pipe.transform({ take: "5000" })).toThrow(BadRequestException);
  });

  test("a non-whitelisted sortBy column → 400", () => {
    expect(() => pipe.transform({ sortBy: "latitude" })).toThrow(BadRequestException);
  });
});

describe("GeofenceStatusQuerySchema (geofence check, pipe layer)", () => {
  const pipe = new ZodValidationPipe(GeofenceStatusQuerySchema);

  test("a complete circle parses", () => {
    const parsed = pipe.transform({
      centerLatitude: "27.7172",
      centerLongitude: "85.324",
      radiusMeters: "100",
    });
    expect(parsed.centerLatitude).toBeCloseTo(27.7172, 6);
    expect(parsed.radiusMeters).toBe(100);
    expect(parsed.polygon).toBeUndefined();
  });

  test("a polygon parses to a closed WKT ring (lon lat order)", () => {
    const parsed = pipe.transform({ polygon: "85.30,27.70;85.35,27.70;85.35,27.74" });
    expect(parsed.polygon).toBeDefined();
    // 3 supplied vertices auto-close to 4 (first repeated last); WKT is lon lat.
    expect(parsed.polygon?.vertexCount).toBe(4);
    expect(parsed.polygon?.wkt).toBe("POLYGON((85.3 27.7, 85.35 27.7, 85.35 27.74, 85.3 27.7))");
  });

  test("both a circle and a polygon → 400 (exactly one)", () => {
    expect(() =>
      pipe.transform({
        centerLatitude: "27.7172",
        centerLongitude: "85.324",
        radiusMeters: "100",
        polygon: "85.30,27.70;85.35,27.70;85.35,27.74",
      }),
    ).toThrow(BadRequestException);
  });

  test("neither a circle nor a polygon → 400", () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });

  test("a partial circle (missing radius) → 400", () => {
    expect(() => pipe.transform({ centerLatitude: "27.7172", centerLongitude: "85.324" })).toThrow(
      BadRequestException,
    );
  });

  test("a polygon with fewer than 3 vertices → 400", () => {
    expect(() => pipe.transform({ polygon: "85.30,27.70;85.35,27.70" })).toThrow(
      BadRequestException,
    );
  });

  test("an out-of-range coordinate → 400", () => {
    expect(() =>
      pipe.transform({ centerLatitude: "120", centerLongitude: "85.324", radiusMeters: "100" }),
    ).toThrow(BadRequestException);
  });

  test("an unknown query key → 400 (.strict())", () => {
    expect(() =>
      pipe.transform({
        centerLatitude: "27.7172",
        centerLongitude: "85.324",
        radiusMeters: "100",
        extra: "1",
      }),
    ).toThrow(BadRequestException);
  });

  // ── The third mode: a STORED fence by geofenceId (ADR-0030 G5) ──

  test("a geofenceId alone parses (the third mode)", () => {
    const parsed = pipe.transform({ geofenceId: "ckstoredfence0000" });
    expect(parsed.geofenceId).toBe("ckstoredfence0000");
    expect(parsed.polygon).toBeUndefined();
    expect(parsed.centerLatitude).toBeUndefined();
  });

  test("a geofenceId AND a circle → 400 (exactly one mode)", () => {
    expect(() =>
      pipe.transform({
        geofenceId: "ckstoredfence0000",
        centerLatitude: "27.7172",
        centerLongitude: "85.324",
        radiusMeters: "100",
      }),
    ).toThrow(BadRequestException);
  });

  test("a geofenceId AND a polygon → 400 (exactly one mode)", () => {
    expect(() =>
      pipe.transform({
        geofenceId: "ckstoredfence0000",
        polygon: "85.30,27.70;85.35,27.70;85.35,27.74",
      }),
    ).toThrow(BadRequestException);
  });

  test("all three modes at once → 400", () => {
    expect(() =>
      pipe.transform({
        geofenceId: "ckstoredfence0000",
        centerLatitude: "27.7172",
        centerLongitude: "85.324",
        radiusMeters: "100",
        polygon: "85.30,27.70;85.35,27.70;85.35,27.74",
      }),
    ).toThrow(BadRequestException);
  });

  test("a non-cuid geofenceId → 400", () => {
    expect(() => pipe.transform({ geofenceId: "not a cuid" })).toThrow(BadRequestException);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part 2 — HTTP boundary (real AuthGuard + RolesGuard chain). The RBAC gate.
// ───────────────────────────────────────────────────────────────────────────

// RBAC-gate tests for the T5 read split (ADR-0029 T5, ADR-0028 c6 / ADR-0027
// c7), mirroring roles.guard.test.ts / telematics.controller.test.ts Part 2:
// the REAL @UseGuards(AuthGuard, RolesGuard) chain (AUTH session source stubbed
// and driven by an `x-test-role` header) hit over real HTTP, proving the
// per-route @RequirePermission decorations enforce the split end-to-end:
//
//   • gps:read-raw   (…/pings)           → ADMIN only      (403 for OFFICE_STAFF)
//   • gps:read-derived (…/location,       → ADMIN + OFFICE_STAFF; a DRIVER (D6)
//     …/geofence-status, …/positions/latest)  reads ONLY their own vehicle's
//                                            per-vehicle status and is 403 on
//                                            the fleet-wide positions route.
//                                            Part 2 pins the UNLINKED-driver
//                                            fail-closed 403s; Part 4 pins the
//                                            LINKED-driver own-vehicle matrix.
//   • anonymous → 401 from AuthGuard on every route (the 401 ≠ 403 contract)
//
// A REAL PrismaService serves the read handlers; the 200 cases use a
// cuid-shaped vehicleId with no pings, so they return empty / null — all the
// RBAC gate needs (spatial correctness is telematics.read.service.test.ts's
// job). The gps-ingest queue is faked (reads never touch it; no live Redis).

const fakeQueue = { add: async () => ({ id: "job_fake" }) };

// AUTH stub identical to telematics.controller.test.ts: AuthGuard calls
// getSession({ headers }); the `x-test-role` header drives the caller's role,
// so one app instance serves every case. No header → null session → 401.
const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
      // `x-test-user` drives the session's user id (the rbac.matrix idiom) so a
      // D6 own-vehicle test (Part 4) can point the session at a real seeded
      // Driver login; it defaults to `user_test` (no Driver row) for the
      // unlinked fail-closed cases in Part 2.
      const userId = headers.get("x-test-user") ?? "user_test";
      return {
        session: {
          id: "sess_test",
          token: "tok_test",
          userId,
          expiresAt: new Date(Date.now() + 60_000),
        },
        user: { id: userId, email: "user@fleetco.test", name: "Test", role },
      };
    },
  },
};

// A cuid-shaped vehicle id with no pings seeded — every read returns empty /
// null / inside:null, i.e. HTTP 200, which is all the gate test asserts.
const VEHICLE_ID = "ckreadrbac000000";
const PINGS = `/api/v1/telematics/vehicles/${VEHICLE_ID}/pings`;
const LOCATION = `/api/v1/telematics/vehicles/${VEHICLE_ID}/location`;
// The fleet-wide latest-positions poll target (ADR-0042 M7): same
// gps:read-derived tier as LOCATION; with no vehicles seeded it returns an
// empty positions array — HTTP 200, all the gate test needs.
const POSITIONS = "/api/v1/telematics/positions/latest";
const GEOFENCE = `/api/v1/telematics/vehicles/${VEHICLE_ID}/geofence-status?centerLatitude=27.7172&centerLongitude=85.324&radiusMeters=100`;
// A geofence-status URL driven by a STORED fence id that does NOT exist (the
// RBAC block seeds no fence). The route-level gps:read-derived gate runs BEFORE
// the handler reads the query, so the gate verdict matches the circle GEOFENCE
// above; the only difference is what a gate-PASSING role sees next — a 404
// (fence-not-found), which itself proves the gate was passed (404 ≠ 403).
const GEOFENCE_BY_ID = `/api/v1/telematics/vehicles/${VEHICLE_ID}/geofence-status?geofenceId=cknostoredfence00`;

// Kathmandu — the seedGeofence default DEPOT square (lon 85.30–85.35, lat
// 27.70–27.75) contains this point, so a fix here is "inside" the stored fence.
const KTM_LAT = 27.7172;
const KTM_LON = 85.324;

describe("Telematics read RBAC (gps:read-raw / gps:read-derived, ADR-0029 T5)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelematicsController],
      providers: [
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        { provide: Logger, useValue: { log: () => undefined } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);

    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  // GET `path`; `role` undefined → no header → 401 path.
  async function status(path: string, role?: string): Promise<number> {
    const headers: Record<string, string> = role === undefined ? {} : { "x-test-role": role };
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.status;
  }

  // ── gps:read-raw — the most-privileged data access, ADMIN only ──

  test("raw pings: ADMIN → 200", async () => {
    expect(await status(PINGS, UserRole.ADMIN)).toBe(200);
  });

  test("raw pings: OFFICE_STAFF → 403 (authed but lacks gps:read-raw)", async () => {
    expect(await status(PINGS, UserRole.OFFICE_STAFF)).toBe(403);
  });

  test("raw pings: DRIVER (reserved, inert) → 403", async () => {
    expect(await status(PINGS, UserRole.DRIVER)).toBe(403);
  });

  test("raw pings: anonymous → 401 from AuthGuard, NOT 403", async () => {
    expect(await status(PINGS)).toBe(401);
  });

  // ── gps:read-derived — live location, ADMIN + OFFICE_STAFF ──

  test("derived location: ADMIN → 200", async () => {
    expect(await status(LOCATION, UserRole.ADMIN)).toBe(200);
  });

  test("derived location: OFFICE_STAFF → 200 (the positive half of the split)", async () => {
    expect(await status(LOCATION, UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("derived location: anonymous → 401", async () => {
    expect(await status(LOCATION)).toBe(401);
  });

  test("derived location: DRIVER with no linked Driver row → 403 fail-closed (D6 own-vehicle predicate)", async () => {
    expect(await status(LOCATION, UserRole.DRIVER)).toBe(403);
  });

  // ── gps:read-derived — fleet-wide latest positions (ADR-0042 M7) ──

  test("latest positions: ADMIN → 200 with a { positions: [...] } body", async () => {
    const res = await fetch(`${baseUrl}${POSITIONS}`, {
      headers: { "x-test-role": UserRole.ADMIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { positions: unknown };
    expect(Array.isArray(body.positions)).toBe(true);
  });

  test("latest positions: OFFICE_STAFF → 200 (same derived tier as /location)", async () => {
    expect(await status(POSITIONS, UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("latest positions: DRIVER → 403 (D6: a driver never reads the fleet, assertCanReadFleetPositions)", async () => {
    // The cap gate now PASSES (DRIVER holds gps:read-derived as of D6), but the
    // fleet-wide route is ADMIN + OFFICE_STAFF only — a driver reads their own
    // vehicle's status, not the whole fleet's live positions.
    expect(await status(POSITIONS, UserRole.DRIVER)).toBe(403);
  });

  test("latest positions: anonymous → 401", async () => {
    expect(await status(POSITIONS)).toBe(401);
  });

  // ── gps:read-derived — geofence status, ADMIN + OFFICE_STAFF ──

  test("derived geofence-status: ADMIN → 200", async () => {
    expect(await status(GEOFENCE, UserRole.ADMIN)).toBe(200);
  });

  test("derived geofence-status: OFFICE_STAFF → 200", async () => {
    expect(await status(GEOFENCE, UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("derived geofence-status: DRIVER with no linked Driver row → 403 fail-closed (D6 own-vehicle predicate)", async () => {
    // Post-D6 the cap gate passes; the own-vehicle predicate then fails closed
    // in resolveOwnDriverId because `user_test` has no Driver row (the D2
    // posture). Part 4 pins a LINKED driver reaching 200 for their own vehicle.
    expect(await status(GEOFENCE, UserRole.DRIVER)).toBe(403);
  });

  test("derived geofence-status: anonymous → 401", async () => {
    expect(await status(GEOFENCE)).toBe(401);
  });

  // ── gps:read-derived — geofence status by a STORED fence id (ADR-0030 G5) ──
  // The route-level gate is mode-agnostic (it runs before the handler reads the
  // query), so the geofenceId mode is gated exactly like circle/polygon. With a
  // non-existent fence id the gate-PASSING roles reach the handler and get 404
  // (fence-not-found) — which itself proves they passed the gate (404 ≠ 403);
  // the denied roles never reach the handler.

  test("geofence-status by geofenceId: ADMIN passes the gate → 404 (not 403/401)", async () => {
    expect(await status(GEOFENCE_BY_ID, UserRole.ADMIN)).toBe(404);
  });

  test("geofence-status by geofenceId: OFFICE_STAFF passes the gate → 404 (the positive half of the split)", async () => {
    expect(await status(GEOFENCE_BY_ID, UserRole.OFFICE_STAFF)).toBe(404);
  });

  test("geofence-status by geofenceId: DRIVER with no linked Driver row → 403 (own-vehicle predicate, before the query is parsed)", async () => {
    // The own-vehicle predicate runs BEFORE toGeofenceQuery, so an unlinked
    // driver 403s regardless of the (stored/circle/polygon) mode — the derived
    // read is scoped by vehicle, not by fence-query shape.
    expect(await status(GEOFENCE_BY_ID, UserRole.DRIVER)).toBe(403);
  });

  test("geofence-status by geofenceId: anonymous → 401", async () => {
    expect(await status(GEOFENCE_BY_ID)).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part 3 — geofence-status by a STORED fence, end-to-end over HTTP (ADR-0030
// G5). Seeds a real DEPOT fence + an inside fix, GETs the endpoint as ADMIN,
// and asserts the response ECHOES the resolved fence's id + type alongside the
// inside boolean — the wire-level proof of the G5 echo (and that no coordinates
// leak). A missing geofenceId returns 404 over the same wire.
// ───────────────────────────────────────────────────────────────────────────

describe("Telematics geofence-status by stored fence (integration, ADR-0030 G5)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let fenceId: string;
  let storedVehicleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelematicsController],
      providers: [
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        { provide: Logger, useValue: { log: () => undefined } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);

    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    // A real DEPOT fence + a fix inside it, seeded directly (the GET handler
    // reads them; it does not care that the AUTH stub's user is not a DB row).
    await resetDb(prisma);
    const adminId = await seedUser(prisma);
    storedVehicleId = (await seedVehicle(prisma, adminId)).id;
    fenceId = (await seedGeofence(prisma, { createdById: adminId })).id;
    await seedGpsPing(prisma, {
      vehicleId: storedVehicleId,
      createdById: adminId,
      latitude: KTM_LAT,
      longitude: KTM_LON,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  test("ADMIN GET …?geofenceId=<id> echoes the fence id + type and inside:true", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/telematics/vehicles/${storedVehicleId}/geofence-status?geofenceId=${fenceId}`,
      { headers: { "x-test-role": UserRole.ADMIN } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      vehicleId: string;
      geofence: { kind: string; geofenceId?: string; type?: string };
      inside: boolean | null;
      latestFixAt: string | null;
    };
    expect(body.vehicleId).toBe(storedVehicleId);
    expect(body.inside).toBe(true);
    expect(body.latestFixAt).not.toBeNull();
    // The echo is the stored fence's id + type — and ONLY that (no coordinates).
    expect(body.geofence).toEqual({ kind: "stored", geofenceId: fenceId, type: "DEPOT" });
    expect(body).not.toHaveProperty("boundaryWkt");
  });

  test("ADMIN GET …?geofenceId=<missing> → 404", async () => {
    const res = await fetch(
      `${baseUrl}/api/v1/telematics/vehicles/${storedVehicleId}/geofence-status?geofenceId=cknosuchfence00000`,
      { headers: { "x-test-role": UserRole.ADMIN } },
    );
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part 4 — the D6 own-vehicle derived-read predicate (DRIVER, real Postgres
// rows). gps:read-derived is now held by DRIVER, so these pin the SERVICE
// predicate that makes the grant safe — the read twin of the Part-3 D4 ingest
// matrix (telematics.controller.test.ts): a driver reads the derived status of
// ONLY the vehicle on their own IN_PROGRESS trip
// (TelematicsService.assertDriverCanReadVehicle), the fleet-wide
// /positions/latest is 403 for a driver, and any other vehicle is 403. The
// session's user id rides x-test-user so it points at the seeded driver login.
// ───────────────────────────────────────────────────────────────────────────

describe("Telematics D6 own-vehicle derived read (DRIVER, real rows)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let driverUserId: string;
  let ownVehicleId: string;
  let completedVehicleId: string;
  let otherVehicleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelematicsController],
      providers: [
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        { provide: Logger, useValue: { log: () => undefined } },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    prisma = moduleRef.get(PrismaService);

    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    // A linked driver with an IN_PROGRESS trip on ownVehicle (and a fix INSIDE
    // the Kathmandu circle used below); a COMPLETED trip on completedVehicle (to
    // prove the on-trip-only rule closes for a non-IN_PROGRESS trip); and
    // otherVehicle the driver has no trip on at all.
    await resetDb(prisma);
    const adminId = await seedUser(prisma, UserRole.ADMIN);
    driverUserId = await seedUser(prisma, UserRole.DRIVER);
    const driver = await seedDriver(prisma, adminId, { userId: driverUserId });
    ownVehicleId = (await seedVehicle(prisma, adminId)).id;
    completedVehicleId = (
      await seedVehicle(prisma, adminId, { registrationNumber: "BA-8-PA-8888" })
    ).id;
    otherVehicleId = (await seedVehicle(prisma, adminId, { registrationNumber: "BA-9-PA-9999" }))
      .id;
    await seedTrip(prisma, {
      vehicleId: ownVehicleId,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.IN_PROGRESS,
      startedAt: new Date(),
    });
    await seedTrip(prisma, {
      vehicleId: completedVehicleId,
      driverId: driver.id,
      createdById: adminId,
      status: TripStatus.COMPLETED,
      startedAt: new Date(Date.now() - 3_600_000),
      endedAt: new Date(),
    });
    await seedGpsPing(prisma, {
      vehicleId: ownVehicleId,
      createdById: adminId,
      latitude: KTM_LAT,
      longitude: KTM_LON,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // A circle centred on the seeded fix, so an in-circle vehicle reads inside:true.
  const CIRCLE = `centerLatitude=${KTM_LAT}&centerLongitude=${KTM_LON}&radiusMeters=100`;

  // GET `path` as the LINKED driver session (role + the seeded user id).
  async function driverGet(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      headers: { "x-test-role": UserRole.DRIVER, "x-test-user": driverUserId },
    });
  }

  test("own vehicle (its IN_PROGRESS trip) geofence-status → 200, inside:true for a fix in the circle", async () => {
    const res = await driverGet(
      `/api/v1/telematics/vehicles/${ownVehicleId}/geofence-status?${CIRCLE}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { inside: boolean | null; latestFixAt: string | null };
    expect(body.inside).toBe(true);
    expect(body.latestFixAt).not.toBeNull();
  });

  test("own vehicle location → 200 with the latest fix", async () => {
    const res = await driverGet(`/api/v1/telematics/vehicles/${ownVehicleId}/location`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fix: unknown };
    expect(body.fix).not.toBeNull();
  });

  test("a DIFFERENT vehicle (no own active trip) geofence-status → 403 (existence-hiding)", async () => {
    const res = await driverGet(
      `/api/v1/telematics/vehicles/${otherVehicleId}/geofence-status?${CIRCLE}`,
    );
    expect(res.status).toBe(403);
  });

  test("a DIFFERENT vehicle location → 403", async () => {
    const res = await driverGet(`/api/v1/telematics/vehicles/${otherVehicleId}/location`);
    expect(res.status).toBe(403);
  });

  test("a vehicle whose own trip is COMPLETED (not IN_PROGRESS) → 403 (derived read is on-trip-only, mirroring ingest)", async () => {
    const res = await driverGet(
      `/api/v1/telematics/vehicles/${completedVehicleId}/geofence-status?${CIRCLE}`,
    );
    expect(res.status).toBe(403);
  });

  test("the fleet-wide /positions/latest → 403 for a linked driver (never the fleet map)", async () => {
    const res = await driverGet("/api/v1/telematics/positions/latest");
    expect(res.status).toBe(403);
  });
});
