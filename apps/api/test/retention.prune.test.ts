import { getQueueToken } from "@nestjs/bullmq";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import {
  GPS_PING_RETENTION_DAYS,
  RetentionService,
  TRACES_PRUNE_CRON,
  TRACES_PRUNE_JOB_NAME,
  TRACES_PRUNE_QUEUE,
  TRACES_PRUNE_SCHEDULER_ID,
} from "../src/modules/retention/retention.service";
import { resetDb } from "./db";
import { seedGpsPing } from "./fixtures/gps-ping";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Service-level boundary test for the traces-prune retention job (ADR-0029 T4,
// commitment 12). This is the LOAD-BEARING, deterministic proof: it calls
// RetentionService.prune(fixedNow) directly against real Prisma (NO Redis, no
// worker), seeds GpsPing rows on both sides of the cutoff, and asserts the old
// rows are hard-deleted and the recent ones kept. A FAKE queue stands in for
// the BullMQ queue: prune() never touches the queue, and onApplicationBootstrap
// (the only method that does) is exercised here against the fake to prove the
// scheduler is upserted idempotently with the keyed id — all without Redis.
//
// The live-Redis end-to-end proof (the real @Processor worker dequeues and
// prunes; the boot scheduler registers on real Redis) is the sibling file
// apps/api/test/retention.worker.test.ts, mirroring telematics.worker.test.ts.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// A FIXED "now" so the boundary is deterministic across runs — never Date.now().
const NOW = new Date("2026-06-04T03:00:00.000Z");
const daysBeforeNow = (days: number): Date => new Date(NOW.getTime() - days * MS_PER_DAY);

describe("RetentionService (traces-prune boundary, ADR-0029 T4)", () => {
  let prisma: PrismaService;
  let service: RetentionService;

  // Fake queue: captures upsertJobScheduler calls for the idempotency test and
  // is otherwise unused (prune() does not enqueue). No Redis required.
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const fakeQueue = { upsertJobScheduler };

  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        RetentionService,
        PrismaService,
        { provide: getQueueToken(TRACES_PRUNE_QUEUE), useValue: fakeQueue },
      ],
    }).compile();
    // No createNestApplication()/init() — so onApplicationBootstrap does NOT
    // fire automatically and no scheduler/Redis is touched. We invoke the boot
    // hook explicitly only in the idempotency test below.
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(RetentionService);
  });

  afterAll(async () => {
    // This module was built without a Nest app, so PrismaService.onModuleDestroy
    // never runs — disconnect the lazily-opened client so Vitest exits clean.
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    upsertJobScheduler.mockClear();
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    const vehicle = await seedVehicle(prisma, adminId);
    vehicleId = vehicle.id;
  });

  test("computeCutoff is exactly now minus the retention window", () => {
    const cutoff = service.computeCutoff(NOW);
    expect(cutoff.getTime()).toBe(NOW.getTime() - GPS_PING_RETENTION_DAYS * MS_PER_DAY);
  });

  test("hard-deletes pings older than the window and keeps recent ones", async () => {
    // Older than the 90-day window -> pruned.
    const old1 = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: daysBeforeNow(120),
    });
    const old2 = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: daysBeforeNow(91),
    });
    // Within the window -> kept (89 days is just inside; 1 day is well inside).
    const recent1 = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: daysBeforeNow(89),
    });
    const recent2 = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: daysBeforeNow(1),
    });

    const { deleted, cutoff } = await service.prune(NOW);

    expect(deleted).toBe(2);
    expect(cutoff.getTime()).toBe(NOW.getTime() - GPS_PING_RETENTION_DAYS * MS_PER_DAY);

    const remainingIds = (
      await prisma.gpsPing.findMany({ select: { id: true }, orderBy: { timestamp: "asc" } })
    ).map((row) => row.id);
    expect(remainingIds).toHaveLength(2);
    expect(remainingIds).toEqual(expect.arrayContaining([recent1.id, recent2.id]));
    expect(remainingIds).not.toContain(old1.id);
    expect(remainingIds).not.toContain(old2.id);
  });

  test("boundary is strict (< cutoff): a ping exactly at the cutoff is KEPT", async () => {
    const cutoff = service.computeCutoff(NOW);
    // Exactly at the cutoff -> NOT strictly older -> kept (deleteMany uses lt).
    const atCutoff = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: cutoff,
    });
    // One millisecond before the cutoff -> older -> pruned.
    const justBefore = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: new Date(cutoff.getTime() - 1),
    });

    const { deleted } = await service.prune(NOW);
    expect(deleted).toBe(1);

    const ids = (await prisma.gpsPing.findMany({ select: { id: true } })).map((row) => row.id);
    expect(ids).toContain(atCutoff.id);
    expect(ids).not.toContain(justBefore.id);
  });

  test("an empty table prunes nothing without error", async () => {
    const { deleted } = await service.prune(NOW);
    expect(deleted).toBe(0);
  });

  test("onApplicationBootstrap upserts a single keyed scheduler idempotently", async () => {
    // Run the boot hook twice (simulating two restarts); both calls UPSERT the
    // SAME keyed id with the cron pattern + job name, so a restart cannot stack
    // a duplicate repeatable. Idempotency lives in upsertJobScheduler's keying;
    // this asserts we always call it with the stable id (never a fresh one).
    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const call of upsertJobScheduler.mock.calls) {
      expect(call[0]).toBe(TRACES_PRUNE_SCHEDULER_ID);
      expect(call[1]).toMatchObject({ pattern: TRACES_PRUNE_CRON });
      expect(call[2]).toMatchObject({ name: TRACES_PRUNE_JOB_NAME });
    }
  });
});
