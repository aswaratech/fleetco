import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { Mailer } from "../src/modules/notifications/mailer";
import { MockMailer } from "../src/modules/notifications/mock.mailer";
import {
  NOTIFICATION_QUEUE,
  REMINDER_SEND_JOB_NAME,
} from "../src/modules/notifications/notification.constants";
import {
  NotificationService,
  type ReminderSendJobData,
} from "../src/modules/notifications/notification.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { QueueModule } from "../src/modules/queue/queue.module";
import { resetDb } from "./db";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Integration tests for the scan → send → dedup behaviors (ADR-0038 C2 c4–c7),
// against the real test DB + a live Redis queue, with the C1 MockMailer injected
// so NO test reaches the network. The boot-scheduler idempotency lives in
// notification.worker.test.ts; here the worker is deliberately NOT registered —
// the scan ENQUEUES send jobs, and the test drains them through the service the
// way the worker would (`deliverEnqueuedSends`), so each behavior is exercised
// deterministically without depending on the async worker.

const NOW = new Date("2026-05-25T12:00:00.000Z");
const EXPIRED_ISO = "2026-05-20T00:00:00.000Z"; // 5 days before NOW → expired
const SOON_ISO = "2026-06-10T00:00:00.000Z"; // 16 days after NOW → expiring-soon
const OK_ISO = "2026-12-31T00:00:00.000Z"; // far future → ok (no reminder)

describe("notification scan → send → dedup (live Redis + DB, ADR-0038 C2)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: NotificationService;
  let queue: Queue;
  const mailer = new MockMailer();
  let adminId: string;

  // Drain the SEND jobs the scan enqueued and deliver each through the service
  // (what the worker's processSend does), so the NotificationLog is written and
  // a follow-up scan can dedup against it.
  async function deliverEnqueuedSends(): Promise<void> {
    const waiting = await queue.getWaiting();
    for (const job of waiting) {
      if (job.name !== REMINDER_SEND_JOB_NAME) continue;
      const data: ReminderSendJobData = job.data;
      await service.send(data);
      await job.remove();
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [QueueModule, BullModule.registerQueue({ name: NOTIFICATION_QUEUE })],
      providers: [
        NotificationService,
        PrismaService,
        // No NotificationProcessor: enqueued jobs stay waiting so the test drives
        // delivery deterministically. The MockMailer records sends, no network.
        { provide: Mailer, useValue: mailer },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    prisma = app.get(PrismaService);
    service = app.get(NotificationService);
    queue = app.get<Queue>(getQueueToken(NOTIFICATION_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await queue.obliterate({ force: true });
    mailer.sent.length = 0;
    // One ADMIN user — the v1 recipient AND the vehicles' createdById FK.
    adminId = await seedUser(prisma, "ADMIN");
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
  });

  test("emails a newly-lapsed item once, and not again on the next scan", async () => {
    await seedVehicle(prisma, adminId, {
      registrationNumber: "BA 2 KHA 1234",
      bluebookExpiresAt: new Date(EXPIRED_ISO),
    });

    const first = await service.scan(NOW);
    expect(first.itemsConsidered).toBe(1);
    expect(first.remindersNewlyDue).toBe(1);
    expect(first.sendJobsEnqueued).toBe(1);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);
    expect(await prisma.notificationLog.count()).toBe(1);

    // Re-scan the same day: the item is still remind-worthy, but already logged.
    const second = await service.scan(NOW);
    expect(second.itemsConsidered).toBe(1);
    expect(second.remindersNewlyDue).toBe(0);
    expect(second.sendJobsEnqueued).toBe(0);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1); // no second email — send-once-per-lapse
  });

  test("a renewal to a new expiry re-arms the reminder (new occurrenceKey)", async () => {
    const vehicle = await seedVehicle(prisma, adminId, {
      bluebookExpiresAt: new Date(EXPIRED_ISO),
    });

    await service.scan(NOW);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);

    // The operator renews the bluebook; the new expiry is a new occurrenceKey.
    await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { bluebookExpiresAt: new Date(SOON_ISO) },
    });

    const rescan = await service.scan(NOW);
    expect(rescan.remindersNewlyDue).toBe(1); // new occurrenceKey → newly-due
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(2);
    expect(await prisma.notificationLog.count()).toBe(2);
  });

  test("expiring-soon then expired for one document are distinct sends", async () => {
    // Expiry one day after NOW → expiring-soon now, expired two days later.
    await seedVehicle(prisma, adminId, {
      bluebookExpiresAt: new Date("2026-05-26T00:00:00.000Z"),
    });

    const soonScan = await service.scan(new Date("2026-05-25T12:00:00.000Z"));
    expect(soonScan.remindersNewlyDue).toBe(1);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);

    const expiredScan = await service.scan(new Date("2026-05-27T12:00:00.000Z"));
    expect(expiredScan.remindersNewlyDue).toBe(1); // same occurrence, new state → distinct
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(2);

    const states = (await prisma.notificationLog.findMany({ select: { state: true } }))
      .map((row) => row.state)
      .sort();
    expect(states).toEqual(["expired", "expiring-soon"]);
  });

  test("an empty digest enqueues nothing and sends nothing (no all-clear email)", async () => {
    await seedVehicle(prisma, adminId, { bluebookExpiresAt: new Date(OK_ISO) });

    const result = await service.scan(NOW);
    expect(result.remindersNewlyDue).toBe(0);
    expect(result.sendJobsEnqueued).toBe(0);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(0);
    expect(await prisma.notificationLog.count()).toBe(0);
  });

  test("delivers to the ADMIN user's email", async () => {
    await seedVehicle(prisma, adminId, { bluebookExpiresAt: new Date(EXPIRED_ISO) });
    const admin = await prisma.user.findUniqueOrThrow({
      where: { id: adminId },
      select: { email: true },
    });

    await service.scan(NOW);
    await deliverEnqueuedSends();

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toEqual([admin.email]);
    expect(mailer.sent[0].subject).toContain("needs attention");
    // The recorded log row carries the recipient for the audit trail.
    const logged = await prisma.notificationLog.findFirstOrThrow();
    expect(logged.recipient).toBe(admin.email);
    expect(logged.sentAt).not.toBeNull();
  });
});
