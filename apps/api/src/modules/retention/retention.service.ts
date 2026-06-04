import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { type Queue } from "bullmq";

// PrismaService is injected by NestJS via emitDecoratorMetadata (see
// apps/api/tsconfig.json); the class reference must remain a value import at
// runtime so the DI container can resolve it. Same eslint override as every
// other vertical-slice service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// The named queue this feature owns (ADR-0029 commitments 2 & 4: per-feature
// queue ownership + named, purpose-specific queues — NOT one polymorphic
// queue). The retention concern owns `traces-prune`, deliberately INDEPENDENT
// of telematics' `gps-ingest`: a slow, daily prune must not share a queue with
// the hot ingestion path (the exact coupling ADR-0029 c4 forbids). The root
// BullMQ config (shared connection + default job options) lives in T1's
// @Global() QueueModule; the concrete queue is registered by RetentionModule.
// Exported so the scheduler (@InjectQueue, here), the worker (@Processor in
// traces-prune.processor.ts), and the module (BullModule.registerQueue) all
// name the SAME string — a typo would otherwise wire a producer to one queue
// and a worker to another with no compile error.
export const TRACES_PRUNE_QUEUE = "traces-prune";

// The job name within the queue. The repeatable scheduler stamps every job it
// creates with this name; an ad-hoc immediate prune (a test, or a future
// operator one-off) uses the same name so the worker handles both identically.
export const TRACES_PRUNE_JOB_NAME = "prune-gps-pings";

// Stable scheduler id (ADR-0029 commitment 12). upsertJobScheduler is KEYED on
// this id, so registering it at every boot UPSERTS the single entry rather
// than stacking a duplicate repeatable per restart. Changing the cadence below
// is a restart-safe edit precisely because this id stays the same.
export const TRACES_PRUNE_SCHEDULER_ID = "traces-prune-daily";

// Cron cadence for the scheduled prune (ADR-0029 commitment 12: "a sane
// low-traffic cadence … flag it as tunable"). 03:00 every day — off-peak, so
// the deleteMany does not contend with daytime ingestion/read load. TUNABLE: a
// daily prune over a 90-day window deletes at most ~1 day of pings per run (a
// small, bounded delete); adjust the cadence here if measured fleet volume
// warrants it (ADR-0029 "Revisit when"). The cron is interpreted in the
// server's timezone; production runs UTC (03:00 UTC ≈ 08:45 Nepal, UTC+05:45),
// well within the off-peak intent.
export const TRACES_PRUNE_CRON = "0 3 * * *";

// Worker concurrency for the prune queue: 1 (ADR-0029 commitment 5 — "the
// prune worker concurrency 1"). The scheduled prune is a single slow job that
// needs no parallelism, and a concurrency of 1 also guarantees two prune runs
// can never overlap (a long-running delete cannot be lapped by the next tick).
export const TRACES_PRUNE_CONCURRENCY = 1;

// ──────────────────────────────────────────────────────────────────────────
// PROVISIONAL raw-ping retention window (ADR-0027 commitment 3 / ADR-0029
// commitment 12). Raw GPS pings are Tier 5 — a surveillance-grade location
// trail (ADR-0027) — and are NOT kept indefinitely; this job hard-deletes
// pings whose fix is older than the window.
//
// ⚠️ PROVISIONAL — the FINAL number is the PO's to set at ADR-0027 acceptance.
// 90 days is the documented provisional default, EXPLICITLY SANCTIONED by
// ADR-0029 commitment 12 ("provisionally 90 days … default to the 90-day
// provisional"). It is sized to cover realistic operational lookback (dispute
// resolution, fuel-theft investigation, billing reconciliation) per ADR-0027
// c3. When the PO fixes the number, change THIS ONE constant — nothing else.
// Tracked in docs/tech-debt.md ("GPS raw-ping retention window is provisional").
// ──────────────────────────────────────────────────────────────────────────
export const GPS_PING_RETENTION_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class RetentionService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(TRACES_PRUNE_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Register the single repeatable prune job IDEMPOTENTLY at boot (ADR-0029
   * commitment 12). `upsertJobScheduler` is keyed on TRACES_PRUNE_SCHEDULER_ID,
   * so each application restart UPSERTS the same entry instead of stacking a
   * new repeatable per boot — a restart cannot duplicate the schedule.
   *
   * Uses bullmq 5.78's Job Schedulers API — the NON-deprecated successor to the
   * old `repeat` option (this choice is recorded in PR #80). Signature pinned
   * against the installed version (ADR-0029 c14): `upsertJobScheduler(id,
   * repeatOpts, jobTemplate)`, where `repeatOpts` carries the cron `pattern`
   * and `jobTemplate.name` is the job name every scheduled run is stamped with.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      TRACES_PRUNE_SCHEDULER_ID,
      { pattern: TRACES_PRUNE_CRON },
      { name: TRACES_PRUNE_JOB_NAME },
    );
  }

  /**
   * The cutoff instant: pings with a fix `timestamp` strictly older than this
   * are pruned. Pure (takes `now` explicitly) so the boundary is
   * deterministically testable without mocking the clock.
   *
   * RETENTION BASIS = `timestamp` (the device fix age) — the natural reading of
   * "raw pings older than the window", and recommended. The alternative basis
   * is `createdAt` (storage age): pruning by `createdAt` is more robust to a
   * late-arriving OFFLINE batch whose old fix-times would otherwise be eligible
   * for pruning almost as soon as it is inserted. We prune by `timestamp`
   * today; switching to `createdAt` is a ONE-LINE change (swap the column in
   * `prune` below) if late offline flushes become a concern — a question the
   * driver-app offline/queueing slice (ADR-0027 c2) may force.
   */
  computeCutoff(now: Date): Date {
    return new Date(now.getTime() - GPS_PING_RETENTION_DAYS * MS_PER_DAY);
  }

  /**
   * Hard-delete raw GPS pings older than the retention window (ADR-0029
   * commitment 12; ADR-0027 commitment 3). Hard-delete is the DEFAULT —
   * aggregation of expiring raw pings into a Tier-3 derived summary (simplified
   * polyline, distance, stop/geofence events) is the preferred end-state but a
   * separate, LATER ticket; ADR-0027 names deletion as the fallback until that
   * feature exists.
   *
   * `now` is a parameter (default `new Date()`) so the worker calls it with no
   * argument while the boundary test passes a fixed instant for determinism.
   * Returns the deleted-row count and the computed cutoff — both safe,
   * non-location values that the worker puts on its span. The prune NEVER reads
   * a coordinate (it filters on `timestamp` only), so no GPS data is in scope
   * here at all; `deleteMany` likewise never touches the GENERATED `geometry`
   * column, so no raw SQL is needed — the row and its derived geometry are
   * removed together by the ordinary Prisma delete.
   */
  async prune(now: Date = new Date()): Promise<{ deleted: number; cutoff: Date }> {
    const cutoff = this.computeCutoff(now);
    const { count } = await this.prisma.gpsPing.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });
    return { deleted: count, cutoff };
  }
}
