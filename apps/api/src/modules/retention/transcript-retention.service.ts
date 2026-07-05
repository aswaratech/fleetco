import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { type Queue } from "bullmq";

// PrismaService and ObjectStorage are injected by NestJS via
// emitDecoratorMetadata (see apps/api/tsconfig.json); the class references
// must remain value imports at runtime so the DI container can resolve them.
// Same eslint override as every other vertical-slice service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ObjectStorage } from "../storage/object-storage";

// The named queue for the AI-agent transcript prune (ADR-0043 commitment 5,
// ticket A2), on the ADR-0029 per-feature-queue pattern the sibling
// traces-prune established: the retention concern owns its prune queues, and
// each prune gets its OWN named queue (never a polymorphic one). Exported so
// the scheduler (@InjectQueue, here), the worker (@Processor in
// transcript-prune.processor.ts), and the module (BullModule.registerQueue)
// all name the SAME string.
export const TRANSCRIPT_PRUNE_QUEUE = "transcript-prune";

// The job name within the queue. The repeatable scheduler stamps every job it
// creates with this name; an ad-hoc immediate prune (a test, or an operator
// one-off) uses the same name so the worker handles both identically.
export const TRANSCRIPT_PRUNE_JOB_NAME = "prune-agent-transcripts";

// Stable scheduler id — upsertJobScheduler is KEYED on this id, so registering
// it at every boot UPSERTS the single entry rather than stacking a duplicate
// repeatable per restart (the ADR-0029 c12 idempotency the traces-prune
// scheduler established).
export const TRANSCRIPT_PRUNE_SCHEDULER_ID = "transcript-prune-daily";

// Daily at 03:30 — off-peak like traces-prune's 03:00, offset by 30 minutes so
// the two retention deletes never run in the same instant (both are small and
// bounded; the offset is politeness, not a correctness requirement). The cron
// is interpreted in the server's timezone; production runs UTC (03:30 UTC ≈
// 09:15 Nepal, UTC+05:45), well within the off-peak intent.
export const TRANSCRIPT_PRUNE_CRON = "30 3 * * *";

// Worker concurrency 1 (the traces-prune posture): the scheduled prune is a
// single slow job that needs no parallelism, and 1 guarantees two prune runs
// can never overlap.
export const TRANSCRIPT_PRUNE_CONCURRENCY = 1;

// The transcript retention window (ADR-0043 commitment 5): agent chat
// transcripts — AgentConversation + AgentMessage rows, Tier 2 content per
// ADR-0043 c6 — are pruned at 180 days. This is an ADR-RATIFIED number (not
// provisional like GPS_PING_RETENTION_DAYS): c5 says "transcripts are pruned
// at 180 days" outright. AgentAction rows are NEVER touched by this job —
// they are the indefinite audit trail; their transcript FKs are ON DELETE SET
// NULL so the conversation delete below DETACHES them (see the schema block
// comment above model AgentConversation).
export const AGENT_TRANSCRIPT_RETENTION_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class TranscriptRetentionService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TRANSCRIPT_PRUNE_QUEUE) private readonly queue: Queue,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Register the single repeatable prune job IDEMPOTENTLY at boot, keyed on
   * TRANSCRIPT_PRUNE_SCHEDULER_ID so each application restart UPSERTS the same
   * entry instead of stacking a new repeatable per boot — exactly the
   * RetentionService.onApplicationBootstrap shape (bullmq Job Schedulers API,
   * the non-deprecated successor to `repeat`; choice recorded in PR #80).
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      TRANSCRIPT_PRUNE_SCHEDULER_ID,
      { pattern: TRANSCRIPT_PRUNE_CRON },
      { name: TRANSCRIPT_PRUNE_JOB_NAME },
    );
  }

  /**
   * The cutoff instant: conversations whose last activity is strictly older
   * than this are pruned. Pure (takes `now` explicitly) so the boundary is
   * deterministically testable without mocking the clock.
   *
   * RETENTION BASIS = `updatedAt` (last activity — @updatedAt, touched by the
   * A5 chat loop's message writes), NOT `createdAt`: an old-but-still-active
   * conversation stays alive, and a conversation goes stale only once it has
   * been untouched for the whole window. The same basis-documented-here
   * posture as RetentionService.computeCutoff's timestamp-vs-createdAt note;
   * switching the basis is a one-line change in `prune` below.
   */
  computeCutoff(now: Date): Date {
    return new Date(now.getTime() - AGENT_TRANSCRIPT_RETENTION_DAYS * MS_PER_DAY);
  }

  /**
   * Hard-delete agent conversations (and, via the agent_message CASCADE FK,
   * their messages) whose last activity is older than the retention window
   * (ADR-0043 c5). The delete DETACHES the audit trail rather than touching
   * it: agent_action's conversation/message FKs are ON DELETE SET NULL, so
   * every AgentAction row survives with nulled transcript refs and its
   * denormalized context (tool, entity, acting user, timestamp) intact — the
   * two-lifecycle seam c5 defines, asserted by the boundary test.
   *
   * `now` is a parameter (default `new Date()`) so the worker calls it with no
   * argument while the boundary test passes a fixed instant. Returns the
   * deleted CONVERSATION count and the computed cutoff — both safe,
   * non-transcript values the worker puts on its span (message rows go with
   * their conversations via the DB-level CASCADE and are not separately
   * counted). No transcript content is ever read here: the prune filters on
   * `updatedAt` only.
   */
  async prune(
    now: Date = new Date(),
  ): Promise<{ deleted: number; cutoff: Date; objectsDeleted: number }> {
    const cutoff = this.computeCutoff(now);

    // Delete stored attachment OBJECTS before the row cascade (ADR-0044 c3:
    // an attachment is transcript content — its bytes die with the
    // transcript). Object-first ordering is idempotent under partial failure:
    // if the row delete below never runs, the next prune re-collects the same
    // keys, and ObjectStorage.delete on an absent key is a no-op by contract.
    // Best-effort per the ADR — a failed object delete never blocks the
    // Tier-2 row prune (the operator belt-and-braces is an R2 lifecycle rule
    // on the agent-attachments/ prefix). Only the opaque r2Key is read here;
    // no transcript content.
    const staleAttachments = await this.prisma.agentAttachment.findMany({
      where: { conversation: { updatedAt: { lt: cutoff } } },
      select: { r2Key: true },
    });
    let objectsDeleted = 0;
    for (const { r2Key } of staleAttachments) {
      try {
        await this.storage.delete(r2Key);
        objectsDeleted += 1;
      } catch {
        // Best-effort: the failure is visible as objectsDeleted <
        // collected-count on the worker span; the row prune proceeds.
      }
    }

    const { count } = await this.prisma.agentConversation.deleteMany({
      where: { updatedAt: { lt: cutoff } },
    });
    return { deleted: count, cutoff, objectsDeleted };
  }
}
