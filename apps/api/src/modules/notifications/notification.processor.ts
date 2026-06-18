import { Processor, WorkerHost } from "@nestjs/bullmq";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { type Job } from "bullmq";

// NotificationService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it (same eslint override as the services/processors). The queue name +
// concurrency constants come from the shared constants file so producer and
// consumer name one source of truth.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { NotificationService } from "./notification.service";
import { type ReminderScanResult, type ReminderSendJobData } from "./notification.service";
import { type MailerSendResult } from "./mailer";
import {
  NOTIFICATION_CONCURRENCY,
  NOTIFICATION_QUEUE,
  REMINDER_SCAN_JOB_NAME,
  REMINDER_SEND_JOB_NAME,
} from "./notification.constants";

// The `notifications` worker (ADR-0038 commitment 4). A @nestjs/bullmq
// @Processor + WorkerHost subclass — the same in-process worker shape as
// traces-prune / gps-ingest (ADR-0029 c1 & c5): it runs inside the API process,
// resolves through the DI container, and is drained on Nest shutdown (the
// enableShutdownHooks() T1 turned on). Concurrency is 1 (ADR-0038 c4 — the scan
// is a single in-process job, and 1 guarantees two scans never overlap).
//
// The one queue carries TWO job kinds (the scan→send split, ADR-0038 c4): the
// daily SCAN job (read sources → enqueue sends) and the per-recipient SEND job
// (deliver one digest). `process` dispatches on the job NAME to the matching
// NotificationService method, each wrapped in ONE span.
//
// ──────────────────────────────────────────────────────────────────────────
// TRACING (ADR-0026 commitment 4): one span per run. The ONLY attributes are
// SAFE operational values — scan COUNTS (items considered / newly-due / send
// jobs enqueued) and, for a send, the recipient COUNT. NEVER a recipient address
// (Tier-2 PII, ADR-0038 c9) and NEVER the digest subject/body. The retention-
// processor posture: don't put sensitive data in a span in the first place.
// ──────────────────────────────────────────────────────────────────────────

const tracer = trace.getTracer("notifications");

@Processor(NOTIFICATION_QUEUE, { concurrency: NOTIFICATION_CONCURRENCY })
export class NotificationProcessor extends WorkerHost {
  constructor(private readonly notifications: NotificationService) {
    super();
  }

  async process(job: Job): Promise<ReminderScanResult | MailerSendResult> {
    if (job.name === REMINDER_SCAN_JOB_NAME) {
      return this.processScan(job);
    }
    if (job.name === REMINDER_SEND_JOB_NAME) {
      return this.processSend(job);
    }
    // Defensive: the scheduler stamps SCAN and the scan enqueues SEND; any other
    // name is a wiring bug. Throw so BullMQ surfaces it in the failed set rather
    // than silently no-op'ing.
    throw new Error(`unknown notification job name: ${job.name}`);
  }

  private async processScan(job: Job): Promise<ReminderScanResult> {
    return tracer.startActiveSpan("notification.scan.process", async (span) => {
      try {
        const result = await this.notifications.scan();
        // Safe, non-PII counts only (see the header note).
        span.setAttribute("notification.scan.items_considered", result.itemsConsidered);
        span.setAttribute("notification.scan.reminders_newly_due", result.remindersNewlyDue);
        span.setAttribute("notification.scan.send_jobs_enqueued", result.sendJobsEnqueued);
        if (job.id !== undefined) {
          span.setAttribute("messaging.message.id", job.id);
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        // Generic ERROR status only — deliberately do NOT recordException, whose
        // message could embed context. BullMQ logs + retries (the failed-set
        // dead-letter is the T1 default). Rethrow so bounded retry fires.
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async processSend(job: Job): Promise<MailerSendResult> {
    return tracer.startActiveSpan("notification.send.process", async (span) => {
      try {
        // job.data is the SEND payload the scan enqueued. Narrow it without `as`
        // (bullmq types data as `any`; a typed binding is enough here).
        const data: ReminderSendJobData = job.data;
        // The recipient COUNT is safe; the addresses are Tier-2 PII and never
        // enter the span (ADR-0038 c9).
        span.setAttribute("notification.send.recipients", data.message.to.length);
        if (job.id !== undefined) {
          span.setAttribute("messaging.message.id", job.id);
        }
        const result = await this.notifications.send(data);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        // Generic ERROR status only — the Mailer's thrown error is PII-free
        // (MailerSendError carries the provider category, never the address) but
        // we still do not recordException, matching the retention posture.
        // BullMQ's bounded retry fires on the rethrow (ADR-0038 c4).
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
