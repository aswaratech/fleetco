import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { type Queue } from "bullmq";
import { Logger } from "nestjs-pino";
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
import { seedCustomer } from "./fixtures/agent";
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
        // NotificationService injects nestjs-pino's Logger (C3 reminder_delivery
        // SLI). This module does not import LoggerModule, so bind a no-op fake —
        // the SLI EMISSION is asserted in notification.sli-emission.test.ts.
        { provide: Logger, useValue: { log: () => undefined } },
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

  // ── C3: the maintenance source folds into the SAME scan ──────────────────
  // seedVehicle defaults odometerCurrentKm = 80000, so an ACTIVE DISTANCE_KM
  // schedule with anchor 70000 + interval 5000 = next-due 75000 is OVERDUE.
  async function seedOverdueDistanceSchedule(vehicleId: string): Promise<void> {
    await prisma.serviceSchedule.create({
      data: {
        vehicleId,
        createdById: adminId,
        name: "10,000 km service",
        intervalType: "DISTANCE_KM",
        intervalValue: 5000,
        status: "ACTIVE",
        lastServiceAt: new Date("2026-01-01T00:00:00.000Z"),
        lastServiceOdometerKm: 70000,
        lastServiceEngineHours: null,
      },
    });
  }

  test("emails an overdue service schedule once, logged as SERVICE_SCHEDULE, deduped on re-scan", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { odometerCurrentKm: 80000 });
    await seedOverdueDistanceSchedule(vehicle.id);

    const first = await service.scan(NOW);
    expect(first.itemsConsidered).toBe(1);
    expect(first.remindersNewlyDue).toBe(1);
    expect(first.sendJobsEnqueued).toBe(1);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).toContain("Maintenance");
    expect(mailer.sent[0].text).toContain("10,000 km service");

    const log = await prisma.notificationLog.findFirstOrThrow();
    expect(log.subjectType).toBe("SERVICE_SCHEDULE");
    expect(log.reminderKind).toBe("SERVICE");
    expect(log.state).toBe("overdue");
    expect(log.occurrenceKey).toBe("75000");

    // Re-scan the same day: still overdue, already logged → no second email.
    const second = await service.scan(NOW);
    expect(second.remindersNewlyDue).toBe(0);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);
  });

  test("an INACTIVE service schedule is never reminded (excluded at the fetch layer)", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { odometerCurrentKm: 80000 });
    await prisma.serviceSchedule.create({
      data: {
        vehicleId: vehicle.id,
        createdById: adminId,
        name: "10,000 km service",
        intervalType: "DISTANCE_KM",
        intervalValue: 5000,
        status: "INACTIVE",
        lastServiceAt: new Date("2026-01-01T00:00:00.000Z"),
        lastServiceOdometerKm: 70000,
        lastServiceEngineHours: null,
      },
    });

    const result = await service.scan(NOW);
    expect(result.itemsConsidered).toBe(0);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(0);
    expect(await prisma.notificationLog.count()).toBe(0);
  });

  test("batches a compliance lapse and a maintenance lapse into ONE digest, TWO log rows", async () => {
    const vehicle = await seedVehicle(prisma, adminId, {
      odometerCurrentKm: 80000,
      bluebookExpiresAt: new Date(EXPIRED_ISO),
    });
    await seedOverdueDistanceSchedule(vehicle.id);

    const result = await service.scan(NOW);
    expect(result.itemsConsidered).toBe(2); // 1 compliance document + 1 schedule
    expect(result.remindersNewlyDue).toBe(2);
    expect(result.sendJobsEnqueued).toBe(1); // one recipient → one digest
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).toContain("Compliance");
    expect(mailer.sent[0].text).toContain("Maintenance");

    const types = (await prisma.notificationLog.findMany({ select: { subjectType: true } }))
      .map((row) => row.subjectType)
      .sort();
    expect(types).toEqual(["SERVICE_SCHEDULE", "VEHICLE"]);
  });

  // ── F6 (ADR-0049 c5): the document source folds into the SAME scan ────────
  // Insert a fleet_document row directly (the scan only reads it; the exactly-
  // one-FK invariant is service-enforced, and one FK is set here). Storage
  // metadata is filler — the scan never touches the bytes.
  async function seedDocument(params: {
    category: string;
    title: string;
    expiresAt: Date | null;
    vehicleId?: string;
    driverId?: string;
    customerId?: string;
  }): Promise<void> {
    await prisma.fleetDocument.create({
      data: {
        vehicleId: params.vehicleId ?? null,
        driverId: params.driverId ?? null,
        customerId: params.customerId ?? null,
        category: params.category as never,
        title: params.title,
        expiresAt: params.expiresAt,
        r2Key: `documents/test/${params.title.replace(/\s+/g, "-")}-${Math.random()
          .toString(36)
          .slice(2)}`,
        contentType: "application/pdf",
        sizeBytes: 1024,
        sha256: "0".repeat(64),
        createdById: adminId,
      },
    });
  }

  test("emails a dated customer-agreement document once, logged as DOCUMENT, deduped on re-scan", async () => {
    const customer = await seedCustomer(prisma, adminId);
    await seedDocument({
      category: "AGREEMENT",
      title: "Haul contract 2083",
      expiresAt: new Date(EXPIRED_ISO),
      customerId: customer.id,
    });

    const first = await service.scan(NOW);
    expect(first.itemsConsidered).toBe(1);
    expect(first.remindersNewlyDue).toBe(1);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].text).toContain("Documents");
    expect(mailer.sent[0].text).toContain("Haul contract 2083");

    const log = await prisma.notificationLog.findFirstOrThrow();
    expect(log.subjectType).toBe("DOCUMENT");
    expect(log.reminderKind).toBe("AGREEMENT");
    expect(log.state).toBe("expired");
    expect(log.occurrenceKey).toBe(EXPIRED_ISO);

    // Re-scan the same day: still expired, already logged → no second email.
    const second = await service.scan(NOW);
    expect(second.remindersNewlyDue).toBe(0);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);
  });

  test("EXCLUSION: a vehicle-attached bluebook document does NOT double-email against the structured field", async () => {
    // A vehicle whose STRUCTURED bluebook expiry is expired — the compliance
    // source reminds on this (subjectType VEHICLE).
    const vehicle = await seedVehicle(prisma, adminId, {
      registrationNumber: "BA 2 KHA 1234",
      bluebookExpiresAt: new Date(EXPIRED_ISO),
    });
    // ...AND a bluebook SCAN uploaded beside it, with an expiry of its own. The
    // document source must SKIP it (the Vehicle field is canonical) — otherwise
    // one lapse would email twice.
    await seedDocument({
      category: "BLUEBOOK",
      title: "Bluebook scan 2083",
      expiresAt: new Date(EXPIRED_ISO),
      vehicleId: vehicle.id,
    });

    const result = await service.scan(NOW);
    // Exactly ONE item — the structured compliance lapse, not the document.
    expect(result.itemsConsidered).toBe(1);
    expect(result.remindersNewlyDue).toBe(1);
    await deliverEnqueuedSends();
    expect(mailer.sent).toHaveLength(1);

    const logs = await prisma.notificationLog.findMany({ select: { subjectType: true } });
    expect(logs).toHaveLength(1);
    expect(logs[0].subjectType).toBe("VEHICLE"); // the compliance source, not DOCUMENT
  });

  test("still reminds on a vehicle-attached AGREEMENT document (no structured twin)", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { registrationNumber: "BA 3 KHA 9999" });
    await seedDocument({
      category: "AGREEMENT",
      title: "Lease agreement 2083",
      expiresAt: new Date(EXPIRED_ISO),
      vehicleId: vehicle.id,
    });

    const result = await service.scan(NOW);
    expect(result.itemsConsidered).toBe(1);
    await deliverEnqueuedSends();

    const log = await prisma.notificationLog.findFirstOrThrow();
    expect(log.subjectType).toBe("DOCUMENT");
    expect(log.reminderKind).toBe("AGREEMENT");
  });
});
