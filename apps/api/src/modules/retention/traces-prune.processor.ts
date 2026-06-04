import { Processor, WorkerHost } from "@nestjs/bullmq";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { type Job } from "bullmq";

// RetentionService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it (same eslint override as the services/processors). The queue name
// + concurrency + window constants come from the same module so the scheduler
// (producer) and this worker (consumer) name one source of truth.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  GPS_PING_RETENTION_DAYS,
  RetentionService,
  TRACES_PRUNE_CONCURRENCY,
  TRACES_PRUNE_QUEUE,
} from "./retention.service";

// The `traces-prune` worker (ADR-0029 commitment 12). A @nestjs/bullmq
// @Processor + WorkerHost subclass — the same in-process worker shape as
// gps-ingest (ADR-0029 c1 & c5): it runs inside the API process, resolves
// through the DI container, and is drained on Nest shutdown (the
// enableShutdownHooks() T1 turned on). Concurrency is 1 (ADR-0029 c5 — the slow
// scheduled job needs no parallelism, and 1 guarantees two prune runs never
// overlap).
//
// ──────────────────────────────────────────────────────────────────────────
// TRACING (ADR-0026 commitment 4): one span per prune run, mirroring
// gps-ingest.processor.ts. The ONLY attributes are SAFE operational values —
// the deleted-row count, the cutoff instant, and the window in days. There are
// NO GPS coordinates in the span: the prune filters on `timestamp` and never
// reads a coordinate, so there is nothing to scrub, and we keep it that way.
// The ADR-0026 span-scrub seam still does NOT exist and is NOT invented here
// (same posture as gps-ingest: never put a coordinate in a span rather than
// scrub one out).
//
// METRICS: the telematics-ping-freshness SLI (ADR-0026 commitment 6) is a
// METER/metrics concern, and NO metrics infrastructure exists yet
// (apps/api/src/observability/otel.ts builds only the TRACE pipeline — there is
// no MeterProvider). This slice therefore does NOT force a metrics seam; the
// freshness metric lands with its own metrics-infrastructure slice. Stated
// explicitly per the T4 ticket — the groundwork is left to that slice, not
// invented here.
// ──────────────────────────────────────────────────────────────────────────

const tracer = trace.getTracer("retention");

@Processor(TRACES_PRUNE_QUEUE, { concurrency: TRACES_PRUNE_CONCURRENCY })
export class TracesPruneProcessor extends WorkerHost {
  constructor(private readonly retention: RetentionService) {
    super();
  }

  async process(job: Job): Promise<{ deleted: number }> {
    return tracer.startActiveSpan("retention.traces-prune.process", async (span) => {
      try {
        const { deleted, cutoff } = await this.retention.prune();

        // Safe, non-location attributes only (see the header note): the volume
        // pruned, the cutoff age, and the configured window. None of these is
        // Tier-5 location data.
        span.setAttribute("retention.pruned.count", deleted);
        span.setAttribute("retention.cutoff", cutoff.toISOString());
        span.setAttribute("retention.window.days", GPS_PING_RETENTION_DAYS);
        if (job.id !== undefined) {
          span.setAttribute("messaging.message.id", job.id);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return { deleted };
      } catch (error) {
        // Generic ERROR status only — deliberately do NOT recordException,
        // whose message could embed row context. BullMQ logs + retries the
        // failure (the failed-set dead-letter is the T1 default). Rethrow so
        // bounded retry fires.
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
