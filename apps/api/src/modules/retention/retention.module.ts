import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { RetentionService, TRACES_PRUNE_QUEUE } from "./retention.service";
import { TracesPruneProcessor } from "./traces-prune.processor";

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
// RetentionService is exported so a future slice (the aggregation-to-summary
// end-state, or an operator-triggered manual prune) can reuse it without a
// circular import.
@Module({
  imports: [BullModule.registerQueue({ name: TRACES_PRUNE_QUEUE })],
  providers: [RetentionService, TracesPruneProcessor],
  exports: [RetentionService],
})
export class RetentionModule {}
