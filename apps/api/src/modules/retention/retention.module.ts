import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { RetentionService, TRACES_PRUNE_QUEUE } from "./retention.service";
import { TracesPruneProcessor } from "./traces-prune.processor";
import { TRANSCRIPT_PRUNE_QUEUE, TranscriptRetentionService } from "./transcript-retention.service";
import { TranscriptPruneProcessor } from "./transcript-prune.processor";

// RetentionModule — the data-lifecycle concern that enforces ADR-0027's short
// raw-trace retention window on GPS pings (ADR-0029 T4). It OWNS the
// `traces-prune` queue per ADR-0029 commitment 2's per-feature queue ownership:
// the root BullMQ config (shared connection + default job options) lives in
// T1's @Global() QueueModule, but the concrete queue is registered HERE via
// BullModule.registerQueue, so the queue's scheduler (RetentionService), its
// worker (TracesPruneProcessor), and the concern they serve live together.
//
// WHY A DEDICATED MODULE (not folded into the telematics module):
//   • ADR-0029 commitment 2 frames retention as its OWN concern — "the
//     retention concern owns `traces-prune`" — and ADR-0027's Consequences
//     names the prune job as a new, standalone data-lifecycle obligation.
//   • Pruning gps_ping rows directly via the shared global PrismaService
//     follows the established in-repo precedent of ReportsModule, which
//     likewise queries OTHER aggregates' tables (fuel_log, expense_log,
//     vehicle) through PrismaService rather than through each owning module's
//     service. The shared PrismaService is infrastructure, not "another
//     module's repository", so this does not breach ADR-0001's
//     no-cross-module-internals rule.
//   • Keeping retention separate leaves the T3 ingestion path (the telematics
//     module's endpoint/worker) entirely untouched, so this slice reviews in
//     isolation — and gives retention a home for when it grows to prune or
//     aggregate other Tier-5 data.
//
// NO controller and NO AuthModule import: this module exposes NO HTTP surface —
// it is a scheduled background job, not a request-handling feature.
//
// As of ADR-0043 A2 the module owns a SECOND prune: `transcript-prune`
// (TranscriptRetentionService + TranscriptPruneProcessor), the 180-day
// AI-agent-transcript retention job — the "grows to prune other data" future
// the paragraph above anticipated. Each prune keeps its OWN named queue
// (ADR-0029 c4: never one polymorphic queue) and its own service/processor
// pair; only the module home is shared, because retention is the concern that
// owns prune jobs (and pruning agent_conversation rows via the shared global
// PrismaService follows the same ReportsModule precedent as gps_ping above).
//
// RetentionService is exported so a future slice (the aggregation-to-summary
// end-state, or an operator-triggered manual prune) can reuse it without a
// circular import; TranscriptRetentionService likewise (A8's runbook names an
// operator-triggered prune as a possible follow-up).
@Module({
  imports: [
    BullModule.registerQueue({ name: TRACES_PRUNE_QUEUE }),
    BullModule.registerQueue({ name: TRANSCRIPT_PRUNE_QUEUE }),
  ],
  providers: [
    RetentionService,
    TracesPruneProcessor,
    TranscriptRetentionService,
    TranscriptPruneProcessor,
  ],
  exports: [RetentionService, TranscriptRetentionService],
})
export class RetentionModule {}
