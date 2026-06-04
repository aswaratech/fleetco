import { Processor, WorkerHost } from "@nestjs/bullmq";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { type Job } from "bullmq";

// TelematicsService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it (same eslint override as the services/controllers). The queue
// name + concurrency constants and the job-data type come from the same
// module so producer and consumer name one source of truth.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  GPS_INGEST_CONCURRENCY,
  GPS_INGEST_QUEUE,
  TelematicsService,
  type GpsIngestJobData,
} from "./telematics.service";

// The `gps-ingest` worker (ADR-0029 commitment 10). A @nestjs/bullmq
// @Processor + WorkerHost subclass — the idiomatic in-process worker shape
// (ADR-0029 commitments 1 & 5): it runs inside the API process, resolves
// through the DI container, and is drained on Nest shutdown (the
// enableShutdownHooks() T1 turned on). Concurrency is tuned per-queue for the
// bulk-insert workload (see GPS_INGEST_CONCURRENCY).
//
// ──────────────────────────────────────────────────────────────────────────
// TRACING (ADR-0026 commitment 4): the BATCH-PROCESSING JOB is the unit of
// tracing, NOT the individual ping. One span per batch wraps the bulk insert.
//
// NO GPS COORDINATES IN SPAN ATTRIBUTES. The coordinate/movement fields are
// Tier 5 (ADR-0027) and must never egress. The ADR-0026 span-scrub seam does
// NOT exist yet (T2 verified apps/api/src/observability/otel.ts builds only
// the OTLP processor — there is no attribute-scrub hook), so the correct
// posture is to never put a coordinate in a span in the first place, rather
// than to invent a scrub here (explicitly deferred — NOT built in T3). The
// only attributes set are the batch size, the inserted count, and the BullMQ
// job id — all Tier-4 operational values, none of them location data.
// ──────────────────────────────────────────────────────────────────────────

const tracer = trace.getTracer("telematics");

@Processor(GPS_INGEST_QUEUE, { concurrency: GPS_INGEST_CONCURRENCY })
export class GpsIngestProcessor extends WorkerHost {
  constructor(private readonly telematics: TelematicsService) {
    super();
  }

  async process(job: Job<GpsIngestJobData>): Promise<{ count: number }> {
    return tracer.startActiveSpan("telematics.gps-ingest.process", async (span) => {
      try {
        // Safe, non-location attributes only (see the header note). Batch size
        // and job id make the span a legible unit of work without any Tier-5
        // egress.
        span.setAttribute("telematics.batch.size", job.data.pings.length);
        if (job.id !== undefined) {
          span.setAttribute("messaging.message.id", job.id);
        }

        const result = await this.telematics.insertBatch(job.data);
        span.setAttribute("telematics.batch.inserted", result.count);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        // Generic ERROR status only — deliberately do NOT recordException,
        // whose message could embed row context. BullMQ logs + retries the
        // failure (the failed-set dead-letter is the T1 default), and the pino
        // redact list covers the log egress. Rethrow so that bounded retry
        // fires.
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
