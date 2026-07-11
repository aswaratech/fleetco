import type { AddressInfo } from "node:net";

import { getQueueToken } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TrackerStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { seedGatewayUser } from "../scripts/seed-gateway-user";
import { GeofencesService } from "../src/modules/geofences/geofences.service";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { INGEST_API_KEY_TOKEN, IngestKeyGuard } from "../src/modules/telematics/ingest-key.guard";
import { GPS_INGEST_QUEUE, TelematicsService } from "../src/modules/telematics/telematics.service";
import { TraccarIngestController } from "../src/modules/telematics/traccar-ingest.controller";
import {
  KNOTS_TO_MS,
  TraccarForwardSchema,
  mapTraccarPosition,
} from "../src/modules/telematics/traccar-ingest.schemas";
import {
  GATEWAY_USER_ID,
  TraccarIngestService,
} from "../src/modules/telematics/traccar-ingest.service";
import { resetDb } from "./db";
import { seedUser, seedVehicle } from "./fixtures/trip";

// The Traccar gateway adapter (ADR-0042 c4/c5/c6, ticket M5), in five layers:
//   1. mapTraccarPosition — the pure foreign→house mapping (knots→m/s,
//      course→heading, attributes.ignition, corrupt-ATTRIBUTE-omitted vs
//      corrupt-FIX-dropped).
//   2. TraccarForwardSchema — the tolerant boundary (unknown keys pass; a
//      payload without coordinates/fixTime/uniqueId is not a position).
//   3. TraccarIngestService — IMEI→vehicle resolution against real Prisma,
//      the drop taxonomy, the house re-validation, the GATEWAY_USER_ID stamp.
//   4. The HTTP boundary — IngestKeyGuard's three branches (unconfigured 503
//      fails closed / bad key 401 / good key through) over real HTTP.
//   5. seed-gateway-user — idempotent, credential-less (no account row).

// A canonical Traccar forward (the forward.type=json shape: one position +
// its device, both open bags).
function makeForward(overrides?: {
  position?: Record<string, unknown>;
  device?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    position: {
      latitude: 27.7172,
      longitude: 85.324,
      altitude: 1400,
      speed: 10, // knots
      course: 90,
      valid: true,
      fixTime: "2026-07-02T06:00:00Z",
      deviceTime: "2026-07-02T06:00:00Z",
      protocol: "teltonika",
      attributes: { ignition: true, motion: true, distance: 12.5, sat: 11 },
      ...overrides?.position,
    },
    device: {
      id: 1,
      uniqueId: "356938035643809",
      name: "FMC920 unit 1",
      status: "online",
      ...overrides?.device,
    },
  };
}

describe("mapTraccarPosition (pure foreign→house mapping)", () => {
  const forward = TraccarForwardSchema.parse(makeForward());

  test("maps coordinates, converts knots→m/s, course→heading, threads ignition + fixTime", () => {
    const ping = mapTraccarPosition(forward, "cmvehicle000000000000001");
    expect(ping.vehicleId).toBe("cmvehicle000000000000001");
    expect(ping.latitude).toBe(27.7172);
    expect(ping.longitude).toBe(85.324);
    expect(ping.speed).toBeCloseTo(10 * KNOTS_TO_MS, 6); // ≈ 5.14444 m/s
    expect(ping.heading).toBe(90);
    expect(ping.ignition).toBe(true);
    expect(ping.altitude).toBe(1400);
    expect(ping.timestamp).toBe("2026-07-02T06:00:00Z");
    // Hardware pings are never trip-bound (ADR-0042 c8).
    expect("tripId" in ping).toBe(false);
  });

  test("a corrupt ATTRIBUTE is omitted, not fatal: course 400 / speed beyond 200 m/s drop the field", () => {
    const weird = TraccarForwardSchema.parse(
      makeForward({ position: { course: 400, speed: 500 } }), // 500 kn ≈ 257 m/s
    );
    const ping = mapTraccarPosition(weird, "cmvehicle000000000000001");
    expect("heading" in ping).toBe(false);
    expect("speed" in ping).toBe(false);
    // The fix itself survives.
    expect(ping.latitude).toBe(27.7172);
  });

  test("course 360 is kept (some devices report a full turn as 360, the house bound allows it)", () => {
    const full = TraccarForwardSchema.parse(makeForward({ position: { course: 360 } }));
    expect(mapTraccarPosition(full, "cmvehicle000000000000001").heading).toBe(360);
  });

  test("absent attributes → no ignition key (NULL in the column, the phone-producer shape)", () => {
    const bare = TraccarForwardSchema.parse(makeForward({ position: { attributes: undefined } }));
    expect("ignition" in mapTraccarPosition(bare, "cmvehicle000000000000001")).toBe(false);
  });
});

describe("TraccarForwardSchema (tolerant boundary — the documented .strict() deviation)", () => {
  test("unknown keys pass at every level (a Traccar upgrade must not become an outage)", () => {
    const payload = makeForward({
      position: { hdop: 0.8, newTraccarField: "whatever" },
      device: { category: "truck", groupId: 7 },
    });
    expect(TraccarForwardSchema.safeParse(payload).success).toBe(true);
  });

  test.each([
    ["missing latitude", { position: { latitude: undefined } }],
    ["missing fixTime", { position: { fixTime: undefined } }],
    ["non-ISO fixTime", { position: { fixTime: "yesterday" } }],
  ])("%s → not a position → rejected", (_name, overrides) => {
    expect(TraccarForwardSchema.safeParse(makeForward(overrides)).success).toBe(false);
  });

  test("missing device.uniqueId → rejected (nothing to resolve a vehicle by)", () => {
    const payload = makeForward();
    delete (payload.device as Record<string, unknown>).uniqueId;
    expect(TraccarForwardSchema.safeParse(payload).success).toBe(false);
  });
});

describe("TraccarIngestService (IMEI resolution + drop taxonomy, real Prisma)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: TraccarIngestService;
  let adminId: string;
  let vehicleId: string;
  let enqueued: { name: string; data: unknown }[];

  const fakeQueue = {
    add: async (name: string, data: unknown) => {
      enqueued.push({ name, data });
      return { id: "job_traccar_1" };
    },
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        TraccarIngestService,
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    service = module.get(TraccarIngestService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    enqueued = [];
    adminId = await seedUser(prisma);
    vehicleId = (await seedVehicle(prisma, adminId, { registrationNumber: "AAA-0001" })).id;
  });

  async function mountDevice(status: TrackerStatus = TrackerStatus.ACTIVE, mounted = true) {
    return prisma.trackerDevice.create({
      data: {
        imei: "356938035643809",
        vehicleId: mounted ? vehicleId : null,
        status,
        createdById: adminId,
      },
    });
  }

  test("a registered ACTIVE mounted device enqueues the mapped ping stamped GATEWAY_USER_ID", async () => {
    await mountDevice();
    const ack = await service.ingestForward(TraccarForwardSchema.parse(makeForward()));

    expect(ack).toEqual({ accepted: 1, dropped: 0, reason: null, jobId: "job_traccar_1" });
    expect(enqueued).toHaveLength(1);
    const payload = enqueued[0].data as {
      createdById: string;
      pings: { vehicleId: string; speed?: number; ignition?: boolean; timestamp: string }[];
    };
    expect(payload.createdById).toBe(GATEWAY_USER_ID);
    expect(payload.pings).toHaveLength(1);
    expect(payload.pings[0].vehicleId).toBe(vehicleId);
    expect(payload.pings[0].speed).toBeCloseTo(10 * KNOTS_TO_MS, 6);
    expect(payload.pings[0].ignition).toBe(true);
  });

  test("an unregistered IMEI is dropped 'unknown-device' (202 — retrying cannot fix it)", async () => {
    const ack = await service.ingestForward(TraccarForwardSchema.parse(makeForward()));
    expect(ack).toEqual({ accepted: 0, dropped: 1, reason: "unknown-device", jobId: null });
    expect(enqueued).toHaveLength(0);
  });

  test("a SPARE (unmounted) device is 'unknown-device' — no vehicle to attribute the fix to", async () => {
    await mountDevice(TrackerStatus.SPARE, false);
    const ack = await service.ingestForward(TraccarForwardSchema.parse(makeForward()));
    expect(ack.reason).toBe("unknown-device");
    expect(enqueued).toHaveLength(0);
  });

  test("valid:false (no satellite lock) is dropped 'invalid-fix' before any lookup", async () => {
    await mountDevice();
    const ack = await service.ingestForward(
      TraccarForwardSchema.parse(makeForward({ position: { valid: false } })),
    );
    expect(ack.reason).toBe("invalid-fix");
    expect(enqueued).toHaveLength(0);
  });

  test("corrupt coordinates fail the house re-validation → 'invalid-values' (tolerance at the boundary never enters the pipeline)", async () => {
    await mountDevice();
    const ack = await service.ingestForward(
      TraccarForwardSchema.parse(makeForward({ position: { latitude: 200 } })),
    );
    expect(ack.reason).toBe("invalid-values");
    expect(enqueued).toHaveLength(0);
  });
});

describe("Traccar ingest HTTP boundary (IngestKeyGuard, real HTTP)", () => {
  const KEY = "k".repeat(32);
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  let adminId: string;

  const fakeQueue = { add: async () => ({ id: "job_http_1" }) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TraccarIngestController],
      providers: [
        TraccarIngestService,
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        IngestKeyGuard,
        { provide: INGEST_API_KEY_TOKEN, useValue: KEY },
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    prisma = moduleRef.get(PrismaService);

    await resetDb(prisma);
    adminId = await seedUser(prisma);
    const vehicle = await seedVehicle(prisma, adminId, { registrationNumber: "AAA-0001" });
    await prisma.trackerDevice.create({
      data: {
        imei: "356938035643809",
        vehicleId: vehicle.id,
        status: TrackerStatus.ACTIVE,
        createdById: adminId,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  async function post(key?: string, body: unknown = makeForward()): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key !== undefined) headers["x-ingest-key"] = key;
    return fetch(`${baseUrl}/api/v1/telematics/ingest/traccar`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  test("the right key + a registered device → 202 accepted", async () => {
    const res = await post(KEY);
    expect(res.status).toBe(202);
    const ack = (await res.json()) as { accepted: number; jobId: string | null };
    expect(ack.accepted).toBe(1);
    expect(ack.jobId).toBe("job_http_1");
  });

  test("a wrong key → 401; a missing key → 401", async () => {
    expect((await post("w".repeat(32))).status).toBe(401);
    expect((await post(undefined)).status).toBe(401);
  });

  test("a payload that is not a position at all → 400 from the pipe (a misconfigured forwarder must surface loudly)", async () => {
    const res = await post(KEY, { hello: "world" });
    expect(res.status).toBe(400);
  });

  test("with NO key configured the guard fails CLOSED: 503 even when a key is presented", async () => {
    const closedModule = await Test.createTestingModule({
      controllers: [TraccarIngestController],
      providers: [
        TraccarIngestService,
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        IngestKeyGuard,
        { provide: INGEST_API_KEY_TOKEN, useValue: null },
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
      ],
    }).compile();
    const closedApp = closedModule.createNestApplication({ logger: false });
    await closedApp.listen(0);
    const addr = closedApp.getHttpServer().address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/v1/telematics/ingest/traccar`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-key": KEY },
        body: JSON.stringify(makeForward()),
      });
      expect(res.status).toBe(503);
    } finally {
      await closedApp.close();
    }
  });
});

describe("seed-gateway-user (idempotent, credential-less)", () => {
  let module: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    module = await Test.createTestingModule({ providers: [PrismaService] }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    await resetDb(prisma);
  });

  afterAll(async () => {
    await module.close();
  });

  test("creates once with the fixed adapter id, is a no-op after, and has NO account row", async () => {
    const first = await seedGatewayUser(prisma);
    expect(first).toEqual({ id: GATEWAY_USER_ID, created: true });

    const second = await seedGatewayUser(prisma);
    expect(second).toEqual({ id: GATEWAY_USER_ID, created: false });
    expect(await prisma.user.count({ where: { id: GATEWAY_USER_ID } })).toBe(1);

    // Credential-less: better-auth authenticates against the account table; a
    // user with no account row cannot sign in through any flow.
    expect(await prisma.account.count({ where: { userId: GATEWAY_USER_ID } })).toBe(0);
  });
});
