import { BullModule } from "@nestjs/bullmq";
import { Global, Module } from "@nestjs/common";
import { type RedisOptions } from "ioredis";

import { env } from "../../config/env";

// QueueModule — the thin, @Global() root of FleetCo's BullMQ job-queue
// substrate (ADR-0029 commitments 2, 3, 5). It registers BullMQ's root
// configuration ONCE via BullModule.forRootAsync: the shared Redis
// connection options and the default job options every queue inherits.
// Mirrors RedisModule's @Global() reach so feature modules can register
// their own queues (BullModule.registerQueue({ name: '...' })) and inject
// producers/workers without re-importing this module.
//
// It deliberately registers NO named queue. Per ADR-0029 commitment 2 the
// concrete queues (gps-ingest, traces-prune, and any future notifications /
// report-generation queue) are owned by the FEATURE module that uses them,
// so a queue's producer, its worker/processor, and the feature it serves
// live together (the ADR-0001 modular-monolith rule). This module owns only
// the shared connection and the cross-queue defaults.
//
// ──────────────────────────────────────────────────────────────────────────
// LOAD-BEARING CONNECTION INVARIANT (ADR-0029 commitment 3) — DO NOT "DRY":
//
// BullMQ gets its OWN dedicated ioredis connection here, configured with
// `maxRetriesPerRequest: null`. It does NOT reuse RedisService
// (apps/api/src/modules/redis/redis.service.ts), and the two MUST STAY
// SEPARATE. The reason is a hard, mutually-exclusive requirement on one
// ioredis setting:
//
//   • RedisService uses `maxRetriesPerRequest: 1` ON PURPOSE so the
//     /health/ready probe (health.service.ts -> redis.ping()) FAILS FAST
//     when Redis is down instead of retrying for tens of seconds.
//   • BullMQ REQUIRES `maxRetriesPerRequest: null` — its workers use
//     blocking commands (BRPOPLPUSH, BZPOPMIN) and THROW at worker startup
//     if the value is any finite number.
//
// `1` and `null` cannot coexist on a single connection. A future agent who
// "DRYs these into one shared Redis connection" breaks EITHER the readiness
// probe (if it takes BullMQ's null) OR every worker at startup (if it takes
// the probe's 1). This is the BullMQ analogue of main.ts's deliberate
// body-parser ordering: a fragile-looking arrangement whose rationale lives
// in the repo precisely so the refactor that would undo it is not made.
//
// We hand BullMQ connection OPTIONS (not a live RedisService instance) and
// let it own the connection lifecycle from the root config. BullMQ also
// internally duplicates this connection (a blocking connection per worker);
// owning the lifecycle here keeps that duplication contained and away from
// the probe's connection.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the dedicated ioredis connection options for BullMQ from REDIS_URL.
 *
 * Same Redis host as RedisService, but a DISTINCT connection with
 * `maxRetriesPerRequest: null` (see the invariant above). Parsing the URL
 * ourselves — rather than handing ioredis the string — lets us layer the
 * `maxRetriesPerRequest` override onto a plain options object that BullMQ
 * accepts directly. Handles auth, a db index in the path, and rediss:// TLS
 * so a managed Redis (a future ADR-0014 production option) works unchanged.
 */
function buildBullConnection(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  const dbFromPath = url.pathname.replace(/^\//, "");
  const db = dbFromPath.length > 0 ? Number(dbFromPath) : undefined;
  return {
    host: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : 6379,
    username: url.username.length > 0 ? decodeURIComponent(url.username) : undefined,
    password: url.password.length > 0 ? decodeURIComponent(url.password) : undefined,
    db: db !== undefined && Number.isInteger(db) ? db : undefined,
    tls: url.protocol === "rediss:" ? {} : undefined,
    // The non-negotiable BullMQ requirement. See the invariant comment above.
    maxRetriesPerRequest: null,
  };
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: buildBullConnection(env.REDIS_URL),
        // Default job options every queue inherits (ADR-0029 commitment 5).
        // Per-queue overrides are applied where a queue is registered.
        defaultJobOptions: {
          // Bounded retry with exponential backoff: 3 total attempts, ~2s,
          // ~4s between them. Enough to ride out a transient Redis/DB blip
          // without hammering a hard-down dependency.
          attempts: 3,
          backoff: { type: "exponential", delay: 2000 },
          // Bound completed-job retention so the `completed` set cannot grow
          // Redis unbounded: keep at most the 1000 most recent, and none
          // older than 1h. (age is seconds.)
          removeOnComplete: { age: 3600, count: 1000 },
          // Keep failed jobs: BullMQ has no separate dead-letter queue, so
          // the `failed` set IS the de-facto DLQ. Jobs that exhaust their
          // retries stay there for inspection rather than vanishing.
          removeOnFail: false,
        },
      }),
    }),
  ],
  // Re-export BullModule so the shared root config registered above is
  // visible (via @Global) to every feature module's BullModule.registerQueue.
  exports: [BullModule],
})
export class QueueModule {}
