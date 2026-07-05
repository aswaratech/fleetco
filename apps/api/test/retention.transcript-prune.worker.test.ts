import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { MockObjectStorage } from "../src/modules/storage/mock.object-storage";
import { ObjectStorage } from "../src/modules/storage/object-storage";
import { QueueModule } from "../src/modules/queue/queue.module";
import {
  TRANSCRIPT_PRUNE_CRON,
  TRANSCRIPT_PRUNE_JOB_NAME,
  TRANSCRIPT_PRUNE_QUEUE,
  TRANSCRIPT_PRUNE_SCHEDULER_ID,
  TranscriptRetentionService,
} from "../src/modules/retention/transcript-retention.service";
import { TranscriptPruneProcessor } from "../src/modules/retention/transcript-prune.processor";
import { resetDb } from "./db";
import { seedAgentAction, seedAgentConversation } from "./fixtures/agent-transcript";
import { seedUser } from "./fixtures/trip";

// Live-Redis integration test for the `transcript-prune` path (ADR-0043 c5,
// ticket A2), mirroring retention.worker.test.ts: the real @Processor worker
// dequeues a prune job and hard-deletes stale conversations (leaving the
// AgentAction audit rows detached), and the boot scheduler upserts the keyed
// repeatable on real Redis.
//
// Like the other worker tests this needs a LIVE Redis (docker-compose locally,
// the redis service in CI) and belongs to the known local-flake family (the
// waitFor poll can time out when a sibling project's Redis squats the port).

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

describe("transcript-prune worker + scheduler (live Redis, ADR-0043 A2)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: TranscriptRetentionService;
  let queue: Queue;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [QueueModule, BullModule.registerQueue({ name: TRANSCRIPT_PRUNE_QUEUE })],
      providers: [
        TranscriptRetentionService,
        TranscriptPruneProcessor,
        PrismaService,
        { provide: ObjectStorage, useValue: new MockObjectStorage() },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // init() runs onApplicationBootstrap, which both starts the BullMQ worker
    // and upserts the scheduler.
    await app.init();

    prisma = app.get(PrismaService);
    service = app.get(TranscriptRetentionService);
    queue = app.get<Queue>(getQueueToken(TRANSCRIPT_PRUNE_QUEUE));

    await queue.obliterate({ force: true });
    await queue.removeJobScheduler(TRANSCRIPT_PRUNE_SCHEDULER_ID);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    userId = await seedUser(prisma);
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
    await queue.removeJobScheduler(TRANSCRIPT_PRUNE_SCHEDULER_ID);
  });

  test("the boot scheduler upserts a single keyed repeatable idempotently", async () => {
    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();

    expect(await queue.getJobSchedulersCount()).toBe(1);
    const scheduler = await queue.getJobScheduler(TRANSCRIPT_PRUNE_SCHEDULER_ID);
    expect(scheduler).toBeTruthy();
    expect(scheduler?.pattern).toBe(TRANSCRIPT_PRUNE_CRON);
  });

  test("an enqueued prune job deletes stale transcripts and detaches their audit rows", async () => {
    // Place rows relative to real now so the assertion holds whenever the
    // suite runs: 200 days is always outside the 180-day window, 1 day inside.
    const now = Date.now();
    const stale = await seedAgentConversation(prisma, userId, {
      updatedAt: new Date(now - 200 * MS_PER_DAY),
    });
    const recent = await seedAgentConversation(prisma, userId, {
      updatedAt: new Date(now - 1 * MS_PER_DAY),
    });
    const action = await seedAgentAction(prisma, userId, { conversationId: stale.id });

    // Enqueue an immediate one-off prune (same job name the scheduler stamps).
    await queue.add(TRANSCRIPT_PRUNE_JOB_NAME, {});

    await waitFor(async () => (await prisma.agentConversation.count()) === 1);

    const remaining = await prisma.agentConversation.findMany({ select: { id: true } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(recent.id);

    // The audit row survived the worker's prune, detached.
    const survivor = await prisma.agentAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(survivor.conversationId).toBeNull();
  });
});
