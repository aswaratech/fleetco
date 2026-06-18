import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { env } from "../../config/env";
import { Mailer } from "./mailer";
import { MockMailer } from "./mock.mailer";
import { ResendMailer } from "./resend.mailer";
import { NOTIFICATION_QUEUE } from "./notification.constants";
import { NotificationProcessor } from "./notification.processor";
import { NotificationService } from "./notification.service";

// NotificationModule — the compliance/maintenance reminder-DELIVERY concern
// (ADR-0038). It OWNS the `notifications` queue per ADR-0029 commitment 2's
// per-feature queue ownership: the root BullMQ config (shared connection +
// default `attempts: 3` job options) lives in T1's @Global() QueueModule, but
// the concrete queue is registered HERE via BullModule.registerQueue, so the
// queue's scheduler (NotificationService), its worker (NotificationProcessor),
// and the concern they serve live together.
//
// WHY A DEDICATED MODULE (not folded into vehicles / maintenance), mirroring
// RetentionModule (ADR-0038 c2):
//   • It is a cross-aggregate background concern that reads several aggregates'
//     due/overdue state through the shared global PrismaService — the in-repo
//     ReportsModule / RetentionModule precedent. The shared PrismaService is
//     infrastructure, not "another module's repository", so this does not
//     breach ADR-0001's no-cross-module-internals rule.
//   • Keeping it separate gives the reminder concern its own home as it grows
//     (the maintenance source in C3, the SLI, a future re-nudge cadence).
//
// NO controller and NO AuthModule import: this module exposes NO HTTP surface —
// it is a scheduled background job, not a request-handling feature (ADR-0038 c2).
//
// THE MAILER DI (ADR-0038 c1): the abstract `Mailer` token resolves to
// ResendMailer in production (where the operator supplies RESEND_API_KEY) and to
// the no-network MockMailer everywhere the key is absent (dev / test / CI), so
// the API never reaches the network outside production — the channel only
// delivers from a deployed system with a verified sending domain. The factory is
// keyed on env.RESEND_API_KEY presence (read through the typed env, never
// logged). Tests OVERRIDE this provider with their own MockMailer instance to
// assert against the recorded `sent` array.
//
// NotificationService is exported so a test harness (or a future
// operator-triggered manual scan) can reach it without a circular import.
@Module({
  imports: [BullModule.registerQueue({ name: NOTIFICATION_QUEUE })],
  providers: [
    NotificationService,
    NotificationProcessor,
    {
      provide: Mailer,
      useFactory: (): Mailer =>
        env.RESEND_API_KEY !== undefined && env.RESEND_API_KEY !== ""
          ? new ResendMailer()
          : new MockMailer(),
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
