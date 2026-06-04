import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { QueueModule } from "../src/modules/queue/queue.module";
import {
  RetentionService,
  TRACES_PRUNE_CRON,
  TRACES_PRUNE_JOB_NAME,
  TRACES_PRUNE_QUEUE,
  TRACES_PRUNE_SCHEDULER_ID,
} from "../src/modules/retention/retention.service";
import { TracesPruneProcessor } from "../src/modules/retention/traces-prune.processor";
import { resetDb } from "./db";
import { seedGpsPing } from "./fixtures/gps-ping";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Live-Redis integration test for the `traces-prune` path (ADR-0029 T4): the
// real @Processor worker dequeues a prune job and hard-deletes old rows, and
// the boot scheduler upserts the keyed repeatable on real Redis. This proves
// the WIRING the deterministic service test (retention.prune.test.ts) cannot:
// queue registration, the WorkerHost worker, and upsertJobScheduler against the
// genuinely-installed bullmq API (ADR-0029 c14).
//
// Like queue.module.test.ts and telematics.worker.test.ts, this needs a LIVE
// Redis (every other API test mocks RedisService). Locally that is
// docker-compose's redis; in CI it is the redis service T1 added to ci.yml.
// REDIS_URL resolves via vitest.config.ts's fallback chain. The setup mirrors
// telematics.worker.test.ts, including the queue obliterate so a prior local
// run's jobs/schedulers cannot leak into these assertions.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

describe("traces-prune worker + scheduler (live Redis, ADR-0029 T4)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: RetentionService;
  let queue: Queue;
  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Real global root config (dedicated maxRetriesPerRequest:null
        // connection + default job options) + the feature queue registration —
        // mirrors RetentionModule's own wiring without importing the module, so
        // the registration is not double-applied.
        QueueModule,
        BullModule.registerQueue({ name: TRACES_PRUNE_QUEUE }),
      ],
      // Real service (scheduler + prune) + the real @Processor worker + Prisma.
      providers: [RetentionService, TracesPruneProcessor, PrismaService],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // init() runs onApplicationBootstrap, which both starts the BullMQ worker
    // and upserts the scheduler.
    await app.init();

    prisma = app.get(PrismaService);
    service = app.get(RetentionService);
    queue = app.get<Queue>(getQueueToken(TRACES_PRUNE_QUEUE));

    // Clear any jobs/schedulers a prior local run left so the worker cannot
    // process stale jobs into our assertions (CI's Redis is ephemeral per run).
    await queue.obliterate({ force: true });
    await queue.removeJobScheduler(TRACES_PRUNE_SCHEDULER_ID);
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
    // Drop this test's jobs + any scheduler it registered before the next, so a
    // run cannot leak (as the smoke / worker tests do).
    await queue.obliterate({ force: true });
    await queue.removeJobScheduler(TRACES_PRUNE_SCHEDULER_ID);
  });

  test("the boot scheduler upserts a single keyed repeatable idempotently", async () => {
    // Re-run the boot hook twice on REAL Redis (init already ran it once, but
    // afterEach cleared it). Two upserts of the same keyed id collapse to ONE
    // scheduler entry — the restart-safe idempotency ADR-0029 c12 requires.
    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();

    expect(await queue.getJobSchedulersCount()).toBe(1);
    const scheduler = await queue.getJobScheduler(TRACES_PRUNE_SCHEDULER_ID);
    expect(scheduler).toBeTruthy();
    expect(scheduler?.pattern).toBe(TRACES_PRUNE_CRON);
  });

  test("an enqueued prune job hard-deletes old pings and keeps recent ones", async () => {
    // Place rows relative to real now so the assertion holds whenever the suite
    // runs: 200 days ago is always outside the 90-day window, 1 day ago always
    // inside.
    const now = Date.now();
    const old = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: new Date(now - 200 * MS_PER_DAY),
    });
    const recent = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      timestamp: new Date(now - 1 * MS_PER_DAY),
    });

    // Enqueue an immediate one-off prune (same job name the scheduler stamps),
    // rather than waiting for the daily cron — the worker handles both alike.
    await queue.add(TRACES_PRUNE_JOB_NAME, {});

    // The worker drains the job asynchronously; wait until only the recent row
    // remains.
    await waitFor(async () => (await prisma.gpsPing.count()) === 1);

    const remaining = await prisma.gpsPing.findMany({ select: { id: true } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(recent.id);
    expect(await prisma.gpsPing.count({ where: { id: old.id } })).toBe(0);
  });
});
