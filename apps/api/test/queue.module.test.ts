import { BullModule, getQueueToken, Processor, WorkerHost } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Job, type Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { QueueModule } from "../src/modules/queue/queue.module";
import { RedisModule } from "../src/modules/redis/redis.module";
import { RedisService } from "../src/modules/redis/redis.service";

// Smoke test for the BullMQ substrate wired by QueueModule (ADR-0029 T1).
// This is the enqueue -> process -> graceful-drain proof the ticket requires:
// a job posted through the real @nestjs/bullmq DI path (@InjectQueue's token)
// is picked up by a real in-process WorkerHost worker on QueueModule's
// dedicated connection, the worker drains in-flight on app.close(), and the
// health-probe connection invariant (the load-bearing reason BullMQ's
// connection is SEPARATE from RedisService's) holds.
//
// The queue here is deliberately named "queue-smoke", NOT a feature queue:
// gps-ingest and traces-prune are owned by their feature modules in T3/T4
// (ADR-0029 commitment 2). Nothing here ships to src/ — the only production
// code T1 adds is QueueModule, the enableShutdownHooks() call, and the deps.
//
// This file needs a LIVE Redis (unlike every other API test, which mocks
// RedisService). Locally that is docker-compose's redis:7-alpine; in CI it is
// the redis service this ticket added to .github/workflows/ci.yml. REDIS_URL
// resolves via vitest.config.ts's fallback chain (.env.test locally,
// the workflow env in CI).

interface SmokeJobData {
  kind: "fast" | "slow";
  payload?: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Coordination between the DI-instantiated processor and the test body. The
// processor closes over these module-scoped handles (Nest constructs it, so
// we cannot inject the deferreds through the constructor).
const fastProcessed = createDeferred<SmokeJobData>();
const slowStarted = createDeferred<string>();
const drainedJobIds: string[] = [];

@Processor("queue-smoke")
class SmokeProcessor extends WorkerHost {
  async process(job: Job<SmokeJobData>): Promise<SmokeJobData> {
    if (job.data.kind === "slow") {
      // Signal that the job is now in-flight, then simulate ~300ms of work.
      // app.close() must wait this out (graceful drain) before the worker
      // closes — that is exactly what the drain test asserts.
      slowStarted.resolve(job.id ?? "");
      await delay(300);
      drainedJobIds.push(job.id ?? "");
      return job.data;
    }
    fastProcessed.resolve(job.data);
    return job.data;
  }
}

describe("QueueModule (BullMQ substrate, ADR-0029 T1)", () => {
  let app: INestApplication;
  let appClosed = false;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Real global root config: dedicated connection + default job options.
        QueueModule,
        // Real RedisService, so the health-probe-invariant test asserts
        // against the genuine :1 connection, not a mock.
        RedisModule,
        // Test-local queue (NOT a feature queue) + its worker fixture below.
        BullModule.registerQueue({ name: "queue-smoke" }),
      ],
      providers: [SmokeProcessor],
    }).compile();

    app = moduleRef.createNestApplication();
    // init() runs onApplicationBootstrap, which starts the BullMQ worker.
    await app.init();

    // Clear any jobs a prior local run left in queue-smoke so the worker
    // cannot resolve our deferred with stale data. CI's Redis is ephemeral
    // per run, so this is a local-dev-repeat safety only.
    const queue = app.get<Queue<SmokeJobData>>(getQueueToken("queue-smoke"));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    // The drain test closes the app itself (to exercise graceful shutdown);
    // close here only if it has not. app.close() runs the shutdown lifecycle,
    // draining + closing the worker and quit()ing RedisService, so Vitest
    // exits with no open handles.
    if (!appClosed) {
      await app.close();
    }
  });

  test("enqueue -> process: a job added via the @nestjs/bullmq queue is picked up by the worker", async () => {
    const queue = app.get<Queue<SmokeJobData>>(getQueueToken("queue-smoke"));

    await queue.add("smoke-fast", { kind: "fast", payload: "hello-bullmq" });

    // The worker resolves this deferred from process(). Awaiting it proves
    // the full DI path: producer (@InjectQueue token) -> Redis -> worker
    // (@Processor + WorkerHost) on QueueModule's dedicated connection.
    const data = await fastProcessed.promise;
    expect(data).toEqual({ kind: "fast", payload: "hello-bullmq" });
  });

  test("health-probe invariant: BullMQ's connection is a DISTINCT instance with maxRetriesPerRequest: null; the probe still pings", async () => {
    const queue = app.get<Queue<SmokeJobData>>(getQueueToken("queue-smoke"));
    const redisService = app.get(RedisService);

    // The live ioredis client BullMQ built from QueueModule's options.
    const bullClient = await queue.client;

    // Distinct connections — NOT the same instance. The whole point of
    // commitment 3: a future "share one Redis connection" refactor must not
    // collapse these two.
    expect(bullClient).not.toBe(redisService);

    // BullMQ requires null (it uses blocking commands and throws otherwise);
    // the health probe requires 1 (fast-fail readiness). Mutually exclusive
    // on one connection — proving each holds its required value on its OWN
    // connection IS the invariant.
    expect(bullClient.options.maxRetriesPerRequest).toBeNull();
    expect(redisService.options.maxRetriesPerRequest).toBe(1);

    // The /health/ready probe path still works against its own connection.
    expect(await redisService.ping()).toBe("PONG");
  });

  test("graceful drain: app.close() blocks until the in-flight worker job finishes", async () => {
    const queue = app.get<Queue<SmokeJobData>>(getQueueToken("queue-smoke"));

    await queue.add("smoke-slow", { kind: "slow" });
    // Wait until the worker has actually started the job (it is now active).
    const inFlightJobId = await slowStarted.promise;
    expect(inFlightJobId).not.toBe("");

    const closeStartedAt = performance.now();
    await app.close(); // graceful: the worker drains its active job first
    const elapsedMs = performance.now() - closeStartedAt;
    appClosed = true;

    // close() BLOCKED for ~the remaining job duration: the worker drained the
    // in-flight job rather than abandoning it. A force-close would return in
    // single-digit ms; the 150ms floor cleanly separates "waited" from "did
    // not" (the job sleeps ~300ms and close starts partway through).
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    // And the job genuinely completed during that drain.
    expect(drainedJobIds).toContain(inFlightJobId);
  });
});
