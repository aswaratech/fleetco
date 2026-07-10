import { getQueueToken } from "@nestjs/bullmq";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { TripStatus, UserRole } from "@prisma/client";
import { Logger } from "nestjs-pino";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { GeofencesService } from "../src/modules/geofences/geofences.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TelematicsController } from "../src/modules/telematics/telematics.controller";
import { IngestBatchSchema } from "../src/modules/telematics/telematics.schemas";
import {
  GPS_INGEST_QUEUE,
  TelematicsService,
  type GpsIngestJobData,
} from "../src/modules/telematics/telematics.service";
import { resetDb } from "./db";
import { makeGpsPingInput } from "./fixtures/gps-ping";
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// Tests for the telematics ingestion ENDPOINT (ADR-0029 T3). Two layers,
// mirroring how every write-path controller is tested here plus the RBAC
// chain from roles.guard.test.ts:
//
//   1. SCHEMA / PIPE layer — ZodValidationPipe over IngestBatchSchema, no
//      server. Pins the minimal-validation contract (commitment 10): valid
//      batch + batch-of-one pass; out-of-range coordinates, non-cuid ids,
//      unknown keys (incl. a body-supplied createdById), bad timestamp, empty
//      batch, and a bare (unwrapped) array all surface as HTTP 400.
//
//   2. HTTP BOUNDARY — the REAL @UseGuards(AuthGuard, RolesGuard) chain (the
//      AUTH session source stubbed and driven by an `x-test-role` header, as
//      in roles.guard.test.ts) hit over real HTTP, with the `gps-ingest` queue
//      OVERRIDDEN by a fake so these tests assert the auth/validation boundary
//      and the enqueue-and-return-fast behaviour WITHOUT a live Redis. The
//      enqueue→insert proof (live Redis + real worker) is the separate
//      telematics.worker.test.ts. Proven here: ADMIN → 202 (and the job is
//      enqueued with createdById from the SESSION, not the body),
//      OFFICE_STAFF → 403, no session → 401, malformed body → 400.

// ---------------------------------------------------------------------------
// Part 1 — schema / pipe layer
// ---------------------------------------------------------------------------

describe("Telematics ingest schema (T3 contract, pipe layer)", () => {
  const pipe = new ZodValidationPipe(IngestBatchSchema);
  const VEHICLE_ID = "ckabc1234567890";

  test("valid batch parses (timestamp stays an ISO string, not a Date)", () => {
    const parsed = pipe.transform({
      pings: [
        makeGpsPingInput({ vehicleId: VEHICLE_ID }),
        makeGpsPingInput({ vehicleId: VEHICLE_ID, latitude: 28.2, longitude: 83.98 }),
      ],
    });
    expect(parsed.pings).toHaveLength(2);
    // The wire/job carries timestamp as a string (it survives BullMQ JSON
    // serialization unchanged); the worker maps it to a Date at insert.
    expect(typeof parsed.pings[0].timestamp).toBe("string");
    expect(parsed.pings[0].vehicleId).toBe(VEHICLE_ID);
  });

  test("batch-of-one parses (a single ping is the degenerate batch)", () => {
    const parsed = pipe.transform({ pings: [makeGpsPingInput({ vehicleId: VEHICLE_ID })] });
    expect(parsed.pings).toHaveLength(1);
  });

  test("optional movement fields and tripId pass through when present", () => {
    const parsed = pipe.transform({
      pings: [
        makeGpsPingInput({
          vehicleId: VEHICLE_ID,
          tripId: "cktrip1234567890",
          altitude: 1400,
          speed: 12.5,
          heading: 270,
        }),
      ],
    });
    expect(parsed.pings[0].altitude).toBe(1400);
    expect(parsed.pings[0].speed).toBe(12.5);
    expect(parsed.pings[0].heading).toBe(270);
    expect(parsed.pings[0].tripId).toBe("cktrip1234567890");
  });

  test("empty batch → 400 (at-least-one-ping)", () => {
    expect(() => pipe.transform({ pings: [] })).toThrow(BadRequestException);
  });

  test("a bare (unwrapped) array → 400 (the body must be { pings: [...] })", () => {
    expect(() => pipe.transform([makeGpsPingInput({ vehicleId: VEHICLE_ID })])).toThrow(
      BadRequestException,
    );
  });

  test("latitude out of range (>90) → 400", () => {
    expect(() =>
      pipe.transform({ pings: [makeGpsPingInput({ vehicleId: VEHICLE_ID, latitude: 91 })] }),
    ).toThrow(BadRequestException);
  });

  test("longitude out of range (<-180) → 400", () => {
    expect(() =>
      pipe.transform({ pings: [makeGpsPingInput({ vehicleId: VEHICLE_ID, longitude: -181 })] }),
    ).toThrow(BadRequestException);
  });

  test("non-cuid vehicleId → 400", () => {
    expect(() =>
      pipe.transform({ pings: [makeGpsPingInput({ vehicleId: "not-a-cuid" })] }),
    ).toThrow(BadRequestException);
  });

  test("non-ISO timestamp → 400", () => {
    expect(() =>
      pipe.transform({
        pings: [makeGpsPingInput({ vehicleId: VEHICLE_ID, timestamp: "15/02/2026 8am" })],
      }),
    ).toThrow(BadRequestException);
  });

  test("server-controlled createdById in a ping → 400 (.strict() — never from the body)", () => {
    // createdById is filled from the authenticated session (ADR-0021); the
    // per-ping .strict() rejects any client attempt to set it.
    expect(() =>
      pipe.transform({
        pings: [{ ...makeGpsPingInput({ vehicleId: VEHICLE_ID }), createdById: "user_x" }],
      }),
    ).toThrow(BadRequestException);
  });

  test("unknown sibling key at the batch level → 400 (.strict() wrapper)", () => {
    expect(() =>
      pipe.transform({ pings: [makeGpsPingInput({ vehicleId: VEHICLE_ID })], extra: 1 }),
    ).toThrow(BadRequestException);
  });

  test("Nepal-offset timestamp (+05:45) is accepted", () => {
    // A device may stamp local-with-offset; { offset: true } accepts it. Pin
    // this so a future tightening to UTC-only would surface here.
    const parsed = pipe.transform({
      pings: [makeGpsPingInput({ vehicleId: VEHICLE_ID, timestamp: "2026-02-15T13:45:00+05:45" })],
    });
    expect(parsed.pings[0].timestamp).toBe("2026-02-15T13:45:00+05:45");
  });
});

// ---------------------------------------------------------------------------
// Part 2 — HTTP boundary (real AuthGuard + RolesGuard chain, fake queue)
// ---------------------------------------------------------------------------

// The fake queue captures the most recent enqueue. Only a request that passes
// BOTH the guard chain (authorized) AND the pipe (valid body) reaches the
// handler and enqueues — guards run before pipes in NestJS, so 401/403/400
// requests never touch this.
let lastJob: { name: string; data: GpsIngestJobData } | null = null;
const fakeQueue = {
  add: async (name: string, data: GpsIngestJobData) => {
    lastJob = { name, data };
    return { id: "job_fake_1" };
  },
};

// AUTH stub identical in spirit to roles.guard.test.ts: AuthGuard calls
// getSession({ headers }); we drive the caller's role via `x-test-role` — and,
// for the D4 own-trip predicate tests, the caller's USER ID via `x-test-user`
// (the rbac.matrix.test.ts idiom), so a session can be a real seeded user the
// Driver.userId link points at. No role header → null session → 401.
const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
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

describe("Telematics ingest HTTP boundary (real AuthGuard + RolesGuard chain)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelematicsController],
      providers: [
        TelematicsService,
        // TelematicsService injects GeofencesService for the G5 stored-fence
        // wiring (ADR-0030); it depends only on PrismaService, already present.
        // Inert for these ingest tests (no geofenceId path is exercised here).
        GeofencesService,
        PrismaService,
        // Override the gps-ingest queue with the fake so these auth/validation
        // tests need no live Redis; the worker test exercises the real queue.
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
        // D4: TelematicsService injects the REAL DriverScopeService (the
        // own-trip predicate resolves the Driver.userId link against real
        // Postgres rows the ownership tests seed).
        DriverScopeService,
        // The controller's ping-freshness SLI line needs the pino Logger
        // token; the rbac.matrix.test.ts stub idiom.
        { provide: Logger, useValue: { log: () => undefined } },
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lastJob = null;
  });

  // POST a JSON body; `role` undefined → no header → 401 path. `user` drives
  // x-test-user for the D4 ownership tests (defaults to user_test in the stub).
  async function post(
    body: unknown,
    role?: string,
    user?: string,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (role !== undefined) headers["x-test-role"] = role;
    if (user !== undefined) headers["x-test-user"] = user;
    const res = await fetch(`${baseUrl}/api/v1/telematics/pings`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null };
  }

  const validBatch = { pings: [makeGpsPingInput({ vehicleId: "ckabc1234567890" })] };

  test("ADMIN posts a valid batch → 202, and the job is enqueued with createdById from the SESSION", async () => {
    const { status, json } = await post(validBatch, UserRole.ADMIN);
    expect(status).toBe(202);
    // The 202 ack: count accepted + the BullMQ job id, no echoed rows.
    expect(json).toEqual({ accepted: 1, jobId: "job_fake_1" });
    // The enqueued job carries the session user's id as createdById (ADR-0021)
    // — NOT anything from the body — and the validated pings.
    expect(lastJob).not.toBeNull();
    expect(lastJob?.data.createdById).toBe("user_test");
    expect(lastJob?.data.pings).toHaveLength(1);
    expect(lastJob?.data.pings[0].vehicleId).toBe("ckabc1234567890");
  });

  test("OFFICE_STAFF posts a valid batch → 403 (authed but lacks gps:ingest), nothing enqueued", async () => {
    const { status } = await post(validBatch, UserRole.OFFICE_STAFF);
    expect(status).toBe(403);
    expect(lastJob).toBeNull();
  });

  test("DRIVER with NO linked Driver row → 403 fail-closed (the predicate, not the guard), nothing enqueued", async () => {
    // Pre-D4 this 403 came from RolesGuard (no gps:ingest). The D4 grant means
    // a DRIVER session now PASSES the guard and reaches the own-trip
    // predicate, where the unlinked session fails closed inside
    // resolveOwnDriverId (the D2 posture) — same status, different (and
    // load-bearing) enforcement layer. `user_test` has no Driver row.
    const { status } = await post(validBatch, UserRole.DRIVER);
    expect(status).toBe(403);
    expect(lastJob).toBeNull();
  });

  test("no session → 401 from AuthGuard, NOT 403 (the 401 != 403 contract)", async () => {
    const { status } = await post(validBatch);
    expect(status).toBe(401);
    expect(lastJob).toBeNull();
  });

  test("ADMIN posts a malformed batch (latitude > 90) → 400, nothing enqueued", async () => {
    const { status } = await post(
      { pings: [makeGpsPingInput({ vehicleId: "ckabc1234567890", latitude: 999 })] },
      UserRole.ADMIN,
    );
    expect(status).toBe(400);
    expect(lastJob).toBeNull();
  });

  test("ADMIN posts a ping carrying createdById → 400 (.strict(); the body cannot set it)", async () => {
    const { status } = await post(
      {
        pings: [
          { ...makeGpsPingInput({ vehicleId: "ckabc1234567890" }), createdById: "user_evil" },
        ],
      },
      UserRole.ADMIN,
    );
    expect(status).toBe(400);
    expect(lastJob).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Part 3 — the D4 own-trip predicate (DRIVER path, real Postgres rows).
  //
  // The grant-with-scope pair (ADR-0034 c5 / ADR-0035 D4): DRIVER now holds
  // gps:ingest, so these pin the SERVICE predicate that makes the grant safe —
  // a driver batch is accepted ONLY for the driver's own IN_PROGRESS trip with
  // the matching vehicle, and ANY violation rejects the WHOLE batch (403,
  // fail-closed) before anything is enqueued. Real rows via the trip fixtures;
  // the session's user id rides x-test-user so it points at the seeded login.
  // -------------------------------------------------------------------------
  describe("D4 own-trip predicate (DRIVER, real rows)", () => {
    let prisma: PrismaService;
    let adminId: string;
    let driverUserId: string;
    let vehicleId: string;
    let tripId: string;

    beforeAll(() => {
      prisma = app.get(PrismaService);
    });

    beforeEach(async () => {
      await resetDb(prisma);
      adminId = await seedUser(prisma, UserRole.ADMIN);
      driverUserId = await seedUser(prisma, UserRole.DRIVER);
      const driver = await seedDriver(prisma, adminId, { userId: driverUserId });
      const vehicle = await seedVehicle(prisma, adminId);
      vehicleId = vehicle.id;
      const trip = await seedTrip(prisma, {
        vehicleId,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date(),
      });
      tripId = trip.id;
    });

    test("own IN_PROGRESS trip + matching vehicle → 202, enqueued with the driver session's createdById", async () => {
      const { status, json } = await post(
        { pings: [makeGpsPingInput({ vehicleId, tripId })] },
        UserRole.DRIVER,
        driverUserId,
      );
      expect(status).toBe(202);
      expect(json).toEqual({ accepted: 1, jobId: "job_fake_1" });
      expect(lastJob?.data.createdById).toBe(driverUserId);
      expect(lastJob?.data.pings[0].tripId).toBe(tripId);
    });

    test("a foreign trip (another driver's) → 403 whole batch, nothing enqueued (existence-hiding 403, not 404)", async () => {
      const otherDriver = await seedDriver(prisma, adminId, {
        licenseNumber: `LIC-${Date.now()}`,
      });
      const otherVehicle = await seedVehicle(prisma, adminId, {
        registrationNumber: "BA-2-PA-0001",
      });
      const foreignTrip = await seedTrip(prisma, {
        vehicleId: otherVehicle.id,
        driverId: otherDriver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date(),
      });
      const { status } = await post(
        { pings: [makeGpsPingInput({ vehicleId: otherVehicle.id, tripId: foreignTrip.id })] },
        UserRole.DRIVER,
        driverUserId,
      );
      expect(status).toBe(403);
      expect(lastJob).toBeNull();
    });

    test("a driver ping WITHOUT tripId → 403 (the phone producer is bound to a trip)", async () => {
      const { status } = await post(
        { pings: [makeGpsPingInput({ vehicleId })] },
        UserRole.DRIVER,
        driverUserId,
      );
      expect(status).toBe(403);
      expect(lastJob).toBeNull();
    });

    test("vehicleId not matching the trip's vehicle → 403 (spoofed/stale payload)", async () => {
      const otherVehicle = await seedVehicle(prisma, adminId, {
        registrationNumber: "BA-3-PA-0002",
      });
      const { status } = await post(
        { pings: [makeGpsPingInput({ vehicleId: otherVehicle.id, tripId })] },
        UserRole.DRIVER,
        driverUserId,
      );
      expect(status).toBe(403);
      expect(lastJob).toBeNull();
    });

    test("own trip that is NOT IN_PROGRESS → 403 (on-trip-only collection, ADR-0035 c1)", async () => {
      const planned = await seedTrip(prisma, {
        vehicleId,
        driverId: (await prisma.driver.findFirstOrThrow({ where: { userId: driverUserId } })).id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      });
      const { status } = await post(
        { pings: [makeGpsPingInput({ vehicleId, tripId: planned.id })] },
        UserRole.DRIVER,
        driverUserId,
      );
      expect(status).toBe(403);
      expect(lastJob).toBeNull();
    });

    test("a mixed batch (one owned ping + one foreign) → 403 for the WHOLE batch, nothing enqueued", async () => {
      const otherDriver = await seedDriver(prisma, adminId, {
        licenseNumber: `LIC-MIX-${Date.now()}`,
      });
      const otherVehicle = await seedVehicle(prisma, adminId, {
        registrationNumber: "BA-4-PA-0003",
      });
      const foreignTrip = await seedTrip(prisma, {
        vehicleId: otherVehicle.id,
        driverId: otherDriver.id,
        createdById: adminId,
        status: TripStatus.IN_PROGRESS,
        startedAt: new Date(),
      });
      const { status } = await post(
        {
          pings: [
            makeGpsPingInput({ vehicleId, tripId }),
            makeGpsPingInput({ vehicleId: otherVehicle.id, tripId: foreignTrip.id }),
          ],
        },
        UserRole.DRIVER,
        driverUserId,
      );
      expect(status).toBe(403);
      expect(lastJob).toBeNull();
    });

    test("ADMIN stays unscoped — a batch with no tripId still → 202 (the c11 synthetic path)", async () => {
      const { status } = await post(
        { pings: [makeGpsPingInput({ vehicleId })] },
        UserRole.ADMIN,
        adminId,
      );
      expect(status).toBe(202);
      expect(lastJob?.data.createdById).toBe(adminId);
    });
  });
});
