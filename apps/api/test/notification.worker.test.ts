import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { Mailer } from "../src/modules/notifications/mailer";
import { MockMailer } from "../src/modules/notifications/mock.mailer";
import {
  NOTIFICATION_QUEUE,
  REMINDER_SCAN_CRON,
  REMINDER_SCAN_JOB_NAME,
  REMINDER_SCAN_SCHEDULER_ID,
  REMINDER_SEND_JOB_NAME,
} from "../src/modules/notifications/notification.constants";
import { NotificationProcessor } from "../src/modules/notifications/notification.processor";
import {
  NotificationService,
  type ReminderSendJobData,
} from "../src/modules/notifications/notification.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { QueueModule } from "../src/modules/queue/queue.module";

// Live-Redis integration test for the `notifications` queue infrastructure
// (ADR-0038 C2, commitments 3–4): the boot scheduler upserts the single keyed
// repeatable, and the real @Processor worker dispatches the two job kinds — the
// SCAN (which, with no source wired in this checkpoint, correctly enqueues and
// sends nothing) and the SEND (which delivers via the injected Mailer). This is
// the notifications analogue of retention.worker.test.ts and proves the WIRING
// the later behavioral tests build on.
//
// Like retention.worker.test.ts / telematics.worker.test.ts this needs a LIVE
// Redis (every other API test mocks RedisService). Locally that is
// docker-compose's redis; in CI it is the redis service in ci.yml. REDIS_URL
// resolves via vitest.config.ts's fallback chain. The MockMailer is injected via
// the Mailer token so no test reaches the network (ADR-0038 c1).

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

describe("notification worker + scheduler (live Redis, ADR-0038 C2)", () => {
  let app: INestApplication;
  let service: NotificationService;
  let queue: Queue;
  const mailer = new MockMailer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // Real global root config (dedicated maxRetriesPerRequest:null connection
        // + default job options) + the feature queue registration — mirrors
        // NotificationModule's own wiring without importing the module, so the
        // registration is not double-applied.
        QueueModule,
        BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
      ],
      providers: [
        NotificationService,
        NotificationProcessor,
        PrismaService,
        // Inject the inspectable MockMailer for the Mailer token so no send
        // reaches the network and the test can assert the recorded `sent`.
        { provide: Mailer, useValue: mailer },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    // init() runs onApplicationBootstrap, which both starts the BullMQ worker
    // and upserts the scheduler.
    await app.init();

    service = app.get(NotificationService);
    queue = app.get<Queue>(getQueueToken(NOTIFICATION_QUEUE));

    // Clear any jobs/schedulers a prior local run left so the worker cannot
    // process stale jobs into our assertions (CI's Redis is ephemeral per run).
    await queue.obliterate({ force: true });
    await queue.removeJobScheduler(REMINDER_SCAN_SCHEDULER_ID);
  });

  afterAll(async () => {
    // app.close() runs the shutdown lifecycle, draining + closing the worker and
    // quitting connections so Vitest exits with no open handles.
    await app.close();
  });

  afterEach(async () => {
    mailer.sent.length = 0;
    await queue.obliterate({ force: true });
    await queue.removeJobScheduler(REMINDER_SCAN_SCHEDULER_ID);
  });

  test("the boot scheduler upserts a single keyed repeatable idempotently", async () => {
    // Re-run the boot hook twice on REAL Redis (init already ran it once, but
    // afterEach cleared it). Two upserts of the same keyed id collapse to ONE
    // scheduler entry — the restart-safe idempotency ADR-0038 c3 requires.
    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();

    expect(await queue.getJobSchedulersCount()).toBe(1);
    const scheduler = await queue.getJobScheduler(REMINDER_SCAN_SCHEDULER_ID);
    expect(scheduler).toBeTruthy();
    expect(scheduler?.pattern).toBe(REMINDER_SCAN_CRON);
  });

  test("an enqueued SCAN job runs to completion and (empty) sends nothing", async () => {
    const job = await queue.add(REMINDER_SCAN_JOB_NAME, {});
    await waitFor(async () => (await job.getState()) === "completed");

    // The empty scan enqueues no SEND jobs and sends no mail (ADR-0038 c4: an
    // empty digest sends nothing — no "all clear" email).
    expect(mailer.sent).toHaveLength(0);
    expect(await queue.getWaitingCount()).toBe(0);
  });

  test("an enqueued SEND job is delivered via the injected Mailer", async () => {
    const payload: ReminderSendJobData = {
      message: {
        to: ["operator@fleetco.example"],
        subject: "FleetCo — 1 item needs attention",
        text: "Bluebook for BA 2 KHA 1234 expired.",
      },
      // No lapses to record in this infra test — the scan→send compliance
      // wiring is exercised by notification.scan.test.ts; here we only prove the
      // worker delivers a SEND job via the injected Mailer.
      logEntries: [],
    };
    await queue.add(REMINDER_SEND_JOB_NAME, payload);

    await waitFor(async () => mailer.sent.length === 1);
    expect(mailer.sent[0].subject).toBe("FleetCo — 1 item needs attention");
    expect(mailer.sent[0].to).toEqual(["operator@fleetco.example"]);
  });
});
