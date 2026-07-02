import { getQueueToken } from "@nestjs/bullmq";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import {
  AGENT_TRANSCRIPT_RETENTION_DAYS,
  TRANSCRIPT_PRUNE_CRON,
  TRANSCRIPT_PRUNE_JOB_NAME,
  TRANSCRIPT_PRUNE_QUEUE,
  TRANSCRIPT_PRUNE_SCHEDULER_ID,
  TranscriptRetentionService,
} from "../src/modules/retention/transcript-retention.service";
import { resetDb } from "./db";
import {
  seedAgentAction,
  seedAgentConversation,
  seedAgentMessage,
} from "./fixtures/agent-transcript";
import { seedUser } from "./fixtures/trip";

// Service-level boundary test for the transcript-prune retention job
// (ADR-0043 c5, ticket A2), mirroring retention.prune.test.ts: it calls
// TranscriptRetentionService.prune(fixedNow) directly against real Prisma (NO
// Redis, no worker), seeds conversations on both sides of the 180-day cutoff,
// and asserts old transcripts are hard-deleted (messages CASCADE with their
// conversation) while recent ones are kept — and, the load-bearing assertion,
// that AgentAction audit rows are NEVER deleted: the SetNull FKs detach them.
//
// The live-Redis end-to-end proof is the sibling
// retention.transcript-prune.worker.test.ts.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// A FIXED "now" so the boundary is deterministic across runs — never Date.now().
const NOW = new Date("2026-07-02T03:30:00.000Z");
const daysBeforeNow = (days: number): Date => new Date(NOW.getTime() - days * MS_PER_DAY);

describe("TranscriptRetentionService (transcript-prune boundary, ADR-0043 A2)", () => {
  let prisma: PrismaService;
  let service: TranscriptRetentionService;

  // Fake queue: captures upsertJobScheduler calls for the idempotency test and
  // is otherwise unused (prune() does not enqueue). No Redis required.
  const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
  const fakeQueue = { upsertJobScheduler };

  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        TranscriptRetentionService,
        PrismaService,
        { provide: getQueueToken(TRANSCRIPT_PRUNE_QUEUE), useValue: fakeQueue },
      ],
    }).compile();
    // No createNestApplication()/init() — so onApplicationBootstrap does NOT
    // fire automatically and no scheduler/Redis is touched.
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(TranscriptRetentionService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    upsertJobScheduler.mockClear();
    await resetDb(prisma);
    userId = await seedUser(prisma);
  });

  test("computeCutoff is exactly now minus the 180-day window", () => {
    const cutoff = service.computeCutoff(NOW);
    expect(cutoff.getTime()).toBe(NOW.getTime() - AGENT_TRANSCRIPT_RETENTION_DAYS * MS_PER_DAY);
  });

  test("hard-deletes stale conversations (messages cascade) and keeps recent ones", async () => {
    const stale = await seedAgentConversation(prisma, userId, {
      updatedAt: daysBeforeNow(200),
    });
    const justStale = await seedAgentConversation(prisma, userId, {
      updatedAt: daysBeforeNow(181),
    });
    const recent = await seedAgentConversation(prisma, userId, {
      updatedAt: daysBeforeNow(179),
    });
    const active = await seedAgentConversation(prisma, userId, {
      updatedAt: daysBeforeNow(1),
    });
    // Seeding a message TOUCHES nothing on the parent (updatedAt is only
    // maintained by Prisma on the parent's own updates), so the backdated
    // basis above stands. NOTE: messages must be seeded BEFORE checking, and
    // seeding a message does not reset the conversation's updatedAt.
    const staleMessage = await seedAgentMessage(prisma, stale.id);
    await seedAgentMessage(prisma, recent.id);

    const { deleted, cutoff } = await service.prune(NOW);

    expect(deleted).toBe(2);
    expect(cutoff.getTime()).toBe(NOW.getTime() - AGENT_TRANSCRIPT_RETENTION_DAYS * MS_PER_DAY);

    const remainingIds = (await prisma.agentConversation.findMany({ select: { id: true } })).map(
      (row) => row.id,
    );
    expect(remainingIds).toHaveLength(2);
    expect(remainingIds).toEqual(expect.arrayContaining([recent.id, active.id]));
    expect(remainingIds).not.toContain(stale.id);
    expect(remainingIds).not.toContain(justStale.id);

    // The stale conversation's message went with it (CASCADE); the recent
    // conversation's message survived.
    expect(await prisma.agentMessage.count({ where: { id: staleMessage.id } })).toBe(0);
    expect(await prisma.agentMessage.count()).toBe(1);
  });

  test("the retention basis is updatedAt (last activity), not createdAt", async () => {
    // Created long before the window opened, but active yesterday → KEPT.
    const oldButActive = await seedAgentConversation(prisma, userId, {
      createdAt: daysBeforeNow(400),
      updatedAt: daysBeforeNow(1),
    });

    const { deleted } = await service.prune(NOW);

    expect(deleted).toBe(0);
    expect(await prisma.agentConversation.count({ where: { id: oldButActive.id } })).toBe(1);
  });

  test("boundary is strict (< cutoff): a conversation exactly at the cutoff is KEPT", async () => {
    const cutoff = service.computeCutoff(NOW);
    const atCutoff = await seedAgentConversation(prisma, userId, { updatedAt: cutoff });
    const justBefore = await seedAgentConversation(prisma, userId, {
      updatedAt: new Date(cutoff.getTime() - 1),
    });

    const { deleted } = await service.prune(NOW);
    expect(deleted).toBe(1);

    const ids = (await prisma.agentConversation.findMany({ select: { id: true } })).map(
      (row) => row.id,
    );
    expect(ids).toContain(atCutoff.id);
    expect(ids).not.toContain(justBefore.id);
  });

  test("AgentAction audit rows SURVIVE the prune, detached with context intact (ADR-0043 c5)", async () => {
    const stale = await seedAgentConversation(prisma, userId, {
      updatedAt: daysBeforeNow(300),
    });
    const staleMessage = await seedAgentMessage(prisma, stale.id, { role: "assistant" });
    const action = await seedAgentAction(prisma, userId, {
      conversationId: stale.id,
      messageId: staleMessage.id,
      toolName: "create_fuel_log",
      argsJson: { vehicleId: "veh_1", litersMl: 45000 },
      resultEntityType: "FuelLog",
      resultEntityId: "fl_1",
      status: "succeeded",
      latencyMs: 60,
    });

    const { deleted } = await service.prune(NOW);
    expect(deleted).toBe(1);

    // The transcript is gone…
    expect(await prisma.agentConversation.count()).toBe(0);
    expect(await prisma.agentMessage.count()).toBe(0);
    // …the audit row is NOT: detached (SetNull) with its denormalized
    // standalone context intact — the two-lifecycle seam.
    const survivor = await prisma.agentAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(survivor.conversationId).toBeNull();
    expect(survivor.messageId).toBeNull();
    expect(survivor.toolName).toBe("create_fuel_log");
    expect(survivor.userId).toBe(userId);
    expect(survivor.resultEntityType).toBe("FuelLog");
    expect(survivor.status).toBe("succeeded");
  });

  test("an empty table prunes nothing without error", async () => {
    const { deleted } = await service.prune(NOW);
    expect(deleted).toBe(0);
  });

  test("onApplicationBootstrap upserts a single keyed scheduler idempotently", async () => {
    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();

    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const call of upsertJobScheduler.mock.calls) {
      expect(call[0]).toBe(TRANSCRIPT_PRUNE_SCHEDULER_ID);
      expect(call[1]).toMatchObject({ pattern: TRANSCRIPT_PRUNE_CRON });
      expect(call[2]).toMatchObject({ name: TRANSCRIPT_PRUNE_JOB_NAME });
    }
  });
});
