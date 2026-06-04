import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { QueueModule } from "../src/modules/queue/queue.module";
import { GpsIngestProcessor } from "../src/modules/telematics/gps-ingest.processor";
import {
  GPS_INGEST_QUEUE,
  TelematicsService,
  type GpsIngestJobData,
} from "../src/modules/telematics/telematics.service";
import { resetDb } from "./db";
import { makeGpsPingInput } from "./fixtures/gps-ping";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Worker integration test for the `gps-ingest` path (ADR-0029 T3, commitment
// 10): enqueue → the real @Processor worker bulk-inserts → rows land in
// Postgres with the generated geometry derived. This is the producer→consumer
// proof the ticket requires, posting SYNTHETIC batches as the seeded principal
// because the driver app does not exist yet.
//
// Like queue.module.test.ts (the T1 smoke test), this file needs a LIVE Redis
// (every other API test mocks RedisService). Locally that is docker-compose's
// redis; in CI it is the redis service T1 added to .github/workflows/ci.yml.
// REDIS_URL resolves via vitest.config.ts's fallback chain. The setup mirrors
// that smoke test exactly, including the queue obliterate so a prior local
// run's jobs cannot leak into these assertions.

// Kathmandu — lat (27.x) and lon (85.x) clearly distinct, so a lon/lat swap in
// the generated geometry is unmissable (same fix the schema round-trip pins).
const KATHMANDU_LAT = 27.7172;
const KATHMANDU_LON = 85.324;

// Poll a predicate until it holds or the timeout elapses. The worker processes
// asynchronously, so a DB assertion must wait for it rather than read once.
async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("gps-ingest worker (enqueue → bulk insert, ADR-0029 T3)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: TelematicsService;
  let queue: Queue<GpsIngestJobData>;
  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Real global root config (dedicated maxRetriesPerRequest:null
        // connection + default job options) + the feature queue registration.
        QueueModule,
        BullModule.registerQueue({ name: GPS_INGEST_QUEUE }),
      ],
      // Real service (producer + insert) + the real @Processor worker + Prisma.
      providers: [TelematicsService, GpsIngestProcessor, PrismaService],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // init() runs onApplicationBootstrap, which starts the BullMQ worker.
    await app.init();

    prisma = app.get(PrismaService);
    service = app.get(TelematicsService);
    queue = app.get<Queue<GpsIngestJobData>>(getQueueToken(GPS_INGEST_QUEUE));

    // Clear any jobs a prior local run left so the worker cannot process stale
    // batches into our assertions (CI's Redis is ephemeral per run).
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    // app.close() runs the shutdown lifecycle, draining + closing the worker
    // and quitting connections so Vitest exits with no open handles.
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    const vehicle = await seedVehicle(prisma, adminId);
    vehicleId = vehicle.id;
  });

  afterEach(async () => {
    // Drop this test's jobs (completed/failed records) before the next so a
    // run cannot leak — as the smoke test does.
    await queue.obliterate({ force: true });
  });

  test("a valid batch is enqueued and bulk-inserted by the worker, geometry derived", async () => {
    const pings = [
      makeGpsPingInput({
        vehicleId,
        latitude: KATHMANDU_LAT,
        longitude: KATHMANDU_LON,
        altitude: 1400,
        speed: 12.5,
        heading: 270,
      }),
      makeGpsPingInput({ vehicleId, latitude: 28.2096, longitude: 83.9856 }),
      makeGpsPingInput({ vehicleId, latitude: 27.6711, longitude: 85.4298 }),
    ];

    const ack = await service.enqueueBatch(pings, adminId);
    expect(ack.accepted).toBe(3);
    expect(ack.jobId).not.toBeNull();

    // The worker drains the job asynchronously; wait until all three rows land.
    await waitFor(async () => (await prisma.gpsPing.count({ where: { vehicleId } })) === 3);

    // The inserted columns round-trip: the worker wrote the native Float
    // lat/lon + movement fields + the createdById from the job payload.
    const first = await prisma.gpsPing.findFirstOrThrow({
      where: { vehicleId, altitude: 1400 },
    });
    expect(first.latitude).toBeCloseTo(KATHMANDU_LAT, 6);
    expect(first.longitude).toBeCloseTo(KATHMANDU_LON, 6);
    expect(first.speed).toBe(12.5);
    expect(first.heading).toBe(270);
    expect(first.createdById).toBe(adminId);
    expect(first.timestamp.toISOString()).toBe("2026-02-15T08:00:00.000Z");

    // The generated geometry derived from the floats (ST_X = lon, ST_Y = lat).
    // Prisma cannot select the Unsupported geometry column, so this is the raw
    // SQL the hybrid representation confines spatial reads to (ADR-0029 c8).
    const rows = await prisma.$queryRaw<{ lon: number; lat: number; srid: number }[]>`
      SELECT ST_X("geometry") AS lon, ST_Y("geometry") AS lat, ST_SRID("geometry") AS srid
      FROM "gps_ping"
      WHERE "id" = ${first.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].lon).toBeCloseTo(KATHMANDU_LON, 6);
    expect(rows[0].lat).toBeCloseTo(KATHMANDU_LAT, 6);
    expect(Number(rows[0].srid)).toBe(4326);
  });

  test("a batch-of-one (the degenerate batch) inserts the single ping", async () => {
    const ack = await service.enqueueBatch(
      [makeGpsPingInput({ vehicleId, latitude: KATHMANDU_LAT, longitude: KATHMANDU_LON })],
      adminId,
    );
    expect(ack.accepted).toBe(1);

    await waitFor(async () => (await prisma.gpsPing.count({ where: { vehicleId } })) === 1);

    const only = await prisma.gpsPing.findFirstOrThrow({ where: { vehicleId } });
    // Movement fields omitted from the input persist as null (a 0 heading is
    // "due north", a distinct fact from "no heading reported").
    expect(only.altitude).toBeNull();
    expect(only.speed).toBeNull();
    expect(only.heading).toBeNull();
    expect(only.tripId).toBeNull();
  });

  test("a ping paired with a trip persists the tripId FK", async () => {
    // tripId is a nullable FK; when supplied (and the trip exists) the worker
    // writes it. Seed a trip for this vehicle so the FK holds.
    const driver = await prisma.driver.create({
      data: {
        fullName: "Ram Bahadur",
        licenseNumber: `LIC-${vehicleId.slice(-8)}`,
        licenseClass: "HTV",
        phone: "+977-9800000000",
        hiredAt: new Date("2022-01-15T00:00:00Z"),
        licenseExpiresAt: new Date("2030-01-01T00:00:00Z"),
        createdById: adminId,
      },
    });
    const trip = await prisma.trip.create({
      data: { vehicleId, driverId: driver.id, status: "IN_PROGRESS", createdById: adminId },
    });

    await service.enqueueBatch([makeGpsPingInput({ vehicleId, tripId: trip.id })], adminId);

    await waitFor(async () => (await prisma.gpsPing.count({ where: { tripId: trip.id } })) === 1);
    const paired = await prisma.gpsPing.findFirstOrThrow({ where: { tripId: trip.id } });
    expect(paired.tripId).toBe(trip.id);
    expect(paired.vehicleId).toBe(vehicleId);
  });
});
