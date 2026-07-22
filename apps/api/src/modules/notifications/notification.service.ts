import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import { type Queue } from "bullmq";
// nestjs-pino's Logger is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a VALUE import at runtime so the DI container resolves it
// by token (the same reason PrismaService/Mailer below stay value imports, and
// the same pattern TripsController uses to emit its SLIs). LoggerModule is global
// (app.module.ts), so this resolves without a module import.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Logger } from "nestjs-pino";

import { env } from "../../config/env";
import { buildReminderDeliverySignal } from "../../common/sli";
// PrismaService and Mailer are injected by NestJS via emitDecoratorMetadata (see
// apps/api/tsconfig.json's experimentalDecorators+emitDecoratorMetadata pair);
// their class references must remain VALUE imports at runtime so the DI
// container can resolve them by token. Same eslint override as every other
// vertical-slice service that injects PrismaService.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Mailer } from "./mailer";
import { type MailMessage, type MailerSendResult } from "./mailer";
import {
  collectVehicleComplianceReminders,
  notificationDedupKey,
  type ReminderItem,
} from "./compliance-source";
import { collectServiceMaintenanceReminders } from "./maintenance-source";
import { collectDocumentExpiryReminders } from "./documents-source";
import { renderReminderDigest } from "./digest";
import {
  NOTIFICATION_QUEUE,
  REMINDER_SCAN_JOB_NAME,
  REMINDER_SCAN_CRON,
  REMINDER_SCAN_SCHEDULER_ID,
  REMINDER_SEND_JOB_NAME,
} from "./notification.constants";

/**
 * Combine the ADMIN users' emails with the optional comma-separated
 * `NOTIFICATION_RECIPIENTS` override into the de-duplicated v1 recipient list
 * (ADR-0038 c7). Pure (no Prisma, no env read) so the override parsing + dedup
 * is unit-testable; the service supplies the admin emails + `env.NOTIFICATION_RECIPIENTS`.
 */
export function combineRecipients(
  adminEmails: readonly string[],
  envValue: string | null | undefined,
): string[] {
  const envList = (envValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set([...adminEmails, ...envList])];
}

/**
 * Counts a scan run produces — all SAFE operational values (no addresses, no
 * document contents) so the worker can put them on its span (ADR-0038 c4).
 */
export interface ReminderScanResult {
  /** Candidate due/overdue items the scan classified this run. */
  itemsConsidered: number;
  /** Items NOT already in the NotificationLog — the newly-crossed ones we email. */
  remindersNewlyDue: number;
  /** SEND jobs enqueued — one per recipient (the scan→send split). */
  sendJobsEnqueued: number;
}

/**
 * One lapse a SEND job records on success — the NotificationLog dedup row
 * (ADR-0038 c5). `recipient` is the joined recipient list (the same for every
 * per-recipient send of one digest, since dedup is per-lapse, not per-recipient).
 */
export interface ReminderLogEntry {
  subjectType: string;
  subjectId: string;
  reminderKind: string;
  state: string;
  occurrenceKey: string;
  recipient: string;
}

/**
 * The payload of a SEND job: the digest addressed to ONE recipient, plus the
 * lapses it covers (recorded in the NotificationLog when the send succeeds, so
 * the next scan skips them — the dedup ledger, ADR-0038 c5).
 */
export interface ReminderSendJobData {
  message: MailMessage;
  logEntries: ReminderLogEntry[];
}

/**
 * NotificationService — the daily reminder SCAN scheduler + the SEND executor
 * (ADR-0038 commitments 3–7), modelled on RetentionService. It registers the
 * single keyed repeatable scan at boot, runs the scan (read the compliance
 * source → diff against the NotificationLog → enqueue one send per recipient),
 * and executes each send (deliver one digest, then record the covered lapses).
 *
 * The dedup is WRITE-AT-SEND-SUCCESS: a lapse's NotificationLog row is created
 * only after its digest is delivered (`send` below), so a failed send is never
 * recorded and the next scan retries it. BullMQ's durable jobs carry an enqueued
 * send across a crash (no drop); the only edge is a rare double-send if the row
 * write fails after a successful provider call, which the queue's bounded retry
 * then repeats — acceptable for the v1 single-operator cadence (ADR-0038 c4/c5).
 */
@Injectable()
export class NotificationService implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    @InjectQueue(NOTIFICATION_QUEUE) private readonly queue: Queue,
    private readonly logger: Logger,
  ) {}

  /**
   * Register the single repeatable scan IDEMPOTENTLY at boot (ADR-0038 c3).
   * `upsertJobScheduler` is keyed on REMINDER_SCAN_SCHEDULER_ID, so each restart
   * UPSERTS the same entry instead of stacking a new repeatable per boot — a
   * restart cannot duplicate the schedule. Uses bullmq's Job Schedulers API (the
   * non-deprecated successor to `repeat`), exactly as RetentionService does.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      REMINDER_SCAN_SCHEDULER_ID,
      { pattern: REMINDER_SCAN_CRON },
      { name: REMINDER_SCAN_JOB_NAME },
    );
  }

  /**
   * Run one reminder scan (ADR-0038 c4–c7): classify every vehicle's compliance
   * expiries via the SHARED `complianceBadgeState`, diff the remind-worthy items
   * against the NotificationLog (send-once-per-lapse), and — for the newly-due
   * ones — render one digest and enqueue one send job per recipient. An empty
   * result enqueues NOTHING (no "all-clear" email, §Voice). Returns SAFE counts
   * for the worker's span. `now` is a parameter (default `new Date()`) so the
   * worker calls it with no argument while tests pin a fixed instant.
   */
  async scan(now: Date = new Date()): Promise<ReminderScanResult> {
    const vehicles = await this.prisma.vehicle.findMany({
      select: {
        id: true,
        registrationNumber: true,
        bluebookExpiresAt: true,
        insuranceExpiresAt: true,
        routePermitExpiresAt: true,
      },
    });

    const complianceItems = collectVehicleComplianceReminders(
      vehicles.map((v) => ({
        id: v.id,
        registrationNumber: v.registrationNumber,
        bluebookExpiresAt: v.bluebookExpiresAt?.toISOString() ?? null,
        insuranceExpiresAt: v.insuranceExpiresAt?.toISOString() ?? null,
        routePermitExpiresAt: v.routePermitExpiresAt?.toISOString() ?? null,
      })),
      now,
    );

    // The MAINTENANCE source (C3): every ACTIVE service schedule, classified by
    // the SHARED `serviceScheduleState` against its vehicle's current meter
    // reading (or the wall clock for a calendar schedule). INACTIVE schedules are
    // excluded at the fetch layer (ADR-0037 c8f). lastServiceAt is converted to
    // an ISO string so the pure source stays string-based, exactly as the
    // compliance vehicles' expiry Dates are.
    const schedules = await this.prisma.serviceSchedule.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        intervalType: true,
        intervalValue: true,
        lastServiceAt: true,
        lastServiceOdometerKm: true,
        lastServiceEngineHours: true,
        vehicle: {
          select: { registrationNumber: true, odometerCurrentKm: true, engineHoursCurrent: true },
        },
      },
    });
    const maintenanceItems = collectServiceMaintenanceReminders(
      schedules.map((s) => ({
        id: s.id,
        name: s.name,
        registrationNumber: s.vehicle.registrationNumber,
        intervalType: s.intervalType,
        intervalValue: s.intervalValue,
        lastServiceAt: s.lastServiceAt.toISOString(),
        lastServiceOdometerKm: s.lastServiceOdometerKm,
        lastServiceEngineHours: s.lastServiceEngineHours,
        odometerCurrentKm: s.vehicle.odometerCurrentKm,
        engineHoursCurrent: s.vehicle.engineHoursCurrent,
      })),
      now,
    );

    // The DOCUMENT source (ADR-0049 c5): every fleet document that carries an
    // expiry, classified by the SAME shared `complianceBadgeState`. The
    // vehicle-compliance-category exclusion lives in the pure source — but it
    // needs `vehicleAttached` per row, so the fetch selects `vehicleId` (for the
    // flag) plus the owning entity's display name across the three FKs. Documents
    // WITHOUT an expiry never remind, so the fetch filters `expiresAt` non-null.
    const documents = await this.prisma.fleetDocument.findMany({
      where: { expiresAt: { not: null } },
      select: {
        id: true,
        category: true,
        title: true,
        expiresAt: true,
        vehicleId: true,
        vehicle: { select: { registrationNumber: true } },
        driver: { select: { fullName: true } },
        customer: { select: { name: true } },
      },
    });
    const documentItems = collectDocumentExpiryReminders(
      documents.map((d) => ({
        id: d.id,
        category: d.category,
        title: d.title,
        expiresAt: d.expiresAt?.toISOString() ?? null,
        // The owning entity's display name — exactly one FK is set (the F2
        // exactly-one invariant), so the first non-null wins.
        entityLabel:
          d.vehicle?.registrationNumber ?? d.driver?.fullName ?? d.customer?.name ?? "Unknown",
        vehicleAttached: d.vehicleId !== null,
      })),
      now,
    );

    // All three sources feed ONE scan → dedup → digest → send pipeline (ADR-0038
    // c4). The digest groups them by domain; the NotificationLog dedups them by
    // the same tuple (distinct subjectTypes keep the keys from colliding).
    const items = [...complianceItems, ...documentItems, ...maintenanceItems];
    if (items.length === 0) {
      return { itemsConsidered: 0, remindersNewlyDue: 0, sendJobsEnqueued: 0 };
    }

    const newItems = await this.filterNewlyDue(items);
    if (newItems.length === 0) {
      return { itemsConsidered: items.length, remindersNewlyDue: 0, sendJobsEnqueued: 0 };
    }

    const recipients = await this.resolveRecipients();
    if (recipients.length === 0) {
      // Newly-due items exist but no recipient is configured. Enqueue nothing;
      // the items stay un-recorded so a later scan (once a recipient exists)
      // still delivers them. (In production an ADMIN always has an email.)
      return {
        itemsConsidered: items.length,
        remindersNewlyDue: newItems.length,
        sendJobsEnqueued: 0,
      };
    }

    const digest = renderReminderDigest(newItems);
    const recipientLabel = recipients.join(", ");
    const logEntries: ReminderLogEntry[] = newItems.map((item) => ({
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      reminderKind: item.reminderKind,
      state: item.state,
      occurrenceKey: item.occurrenceKey,
      recipient: recipientLabel,
    }));

    // The scan→send split (ADR-0038 c4): one send job per recipient, each
    // independently retried by the queue's attempts:3 defaults. Same digest
    // content; only the `to` differs.
    for (const recipient of recipients) {
      const data: ReminderSendJobData = {
        message: {
          to: [recipient],
          subject: digest.subject,
          text: digest.text,
          html: digest.html,
        },
        logEntries,
      };
      await this.queue.add(REMINDER_SEND_JOB_NAME, data);
    }

    return {
      itemsConsidered: items.length,
      remindersNewlyDue: newItems.length,
      sendJobsEnqueued: recipients.length,
    };
  }

  /**
   * Deliver one digest email, then record the lapses it covered as sent (the
   * dedup ledger, ADR-0038 c5). The Mailer REJECTS on a provider error so the
   * queue's bounded retry fires and the log is NOT written for a failed send.
   * `createMany` with `skipDuplicates` makes a second per-recipient send of the
   * same digest a no-op on the rows the first send already wrote.
   *
   * THE reminder_delivery SLI (ADR-0038 c8): the valid event is THIS provider
   * send ATTEMPT, so the signal is logged in the try/catch SCOPED to
   * `mailer.send` — the good line is emitted on the provider's ack, BEFORE the
   * NotificationLog write, so a (rare) log-write failure cannot retroactively
   * flip a recorded provider ack. On a thrown send error the bad line carries
   * `error_kind` (the exception CLASS NAME only — `buildReminderDeliverySignal`
   * derives it, never `err.message`, which can embed the Tier-2 address), then
   * the error is rethrown so BullMQ's bounded retry fires and the log stays
   * unwritten. An idle scan never reaches here, so it is never counted (the
   * "count attempts, not non-attempts" rule).
   */
  async send(data: ReminderSendJobData): Promise<MailerSendResult> {
    let result: MailerSendResult;
    try {
      result = await this.mailer.send(data.message);
    } catch (error) {
      this.logger.log(buildReminderDeliverySignal(error));
      throw error;
    }
    this.logger.log(buildReminderDeliverySignal());

    if (data.logEntries.length > 0) {
      const sentAt = new Date();
      await this.prisma.notificationLog.createMany({
        data: data.logEntries.map((entry) => ({
          subjectType: entry.subjectType,
          subjectId: entry.subjectId,
          reminderKind: entry.reminderKind,
          state: entry.state,
          occurrenceKey: entry.occurrenceKey,
          recipient: entry.recipient,
          sentAt,
          providerMessageId: result.id ?? null,
        })),
        skipDuplicates: true,
      });
    }

    return result;
  }

  /**
   * Keep only the items whose dedup key is ABSENT from the NotificationLog — the
   * newly-crossed lapses (ADR-0038 c5). One query fetches the existing keys for
   * the candidate subjects; the in-memory diff uses the same `notificationDedupKey`
   * the DB's @@unique enforces.
   *
   * The lookup matches on the (subjectType, subjectId) PAIR via an OR per present
   * subjectType — so VEHICLE compliance and SERVICE_SCHEDULE maintenance never
   * cross-match (both ids are cuids), and a new subject type added later needs no
   * change here. (C2 hardcoded subjectType=VEHICLE; C3 generalizes it now that the
   * scan emits two subject types into the same ledger.)
   */
  private async filterNewlyDue(items: readonly ReminderItem[]): Promise<ReminderItem[]> {
    const idsByType = new Map<string, Set<string>>();
    for (const item of items) {
      const ids = idsByType.get(item.subjectType) ?? new Set<string>();
      ids.add(item.subjectId);
      idsByType.set(item.subjectType, ids);
    }
    const existing = await this.prisma.notificationLog.findMany({
      where: {
        OR: [...idsByType.entries()].map(([subjectType, ids]) => ({
          subjectType,
          subjectId: { in: [...ids] },
        })),
      },
      select: {
        subjectType: true,
        subjectId: true,
        reminderKind: true,
        state: true,
        occurrenceKey: true,
      },
    });
    const seen = new Set(existing.map(notificationDedupKey));
    return items.filter((item) => !seen.has(notificationDedupKey(item)));
  }

  /**
   * The v1 recipients (ADR-0038 c7): every ADMIN user's email plus the optional
   * comma-separated `NOTIFICATION_RECIPIENTS` env override, de-duplicated. The
   * env list is the escape hatch for a shared inbox or a non-user address.
   */
  private async resolveRecipients(): Promise<string[]> {
    const admins = await this.prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { email: true },
    });
    return combineRecipients(
      admins.map((admin) => admin.email),
      env.NOTIFICATION_RECIPIENTS,
    );
  }
}
