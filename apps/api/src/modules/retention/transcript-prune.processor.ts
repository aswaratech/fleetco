import { Processor, WorkerHost } from "@nestjs/bullmq";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { type Job } from "bullmq";

// TranscriptRetentionService is injected by NestJS via emitDecoratorMetadata;
// the class reference must remain a value import at runtime so the DI
// container can resolve it (same eslint override as the services/processors).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  AGENT_TRANSCRIPT_RETENTION_DAYS,
  TRANSCRIPT_PRUNE_CONCURRENCY,
  TRANSCRIPT_PRUNE_QUEUE,
  TranscriptRetentionService,
} from "./transcript-retention.service";

// The `transcript-prune` worker (ADR-0043 commitment 5, ticket A2) — the
// AI-agent-transcript twin of traces-prune.processor.ts: a @nestjs/bullmq
// @Processor + WorkerHost running inside the API process, concurrency 1 so two
// prune runs can never overlap, drained on Nest shutdown.
//
// TRACING: one span per prune run. The ONLY attributes are SAFE operational
// values — the deleted-conversation count, the cutoff instant, and the window
// in days. NO transcript content is ever on a span: the prune filters on
// `updatedAt` and never reads a message row, so there is nothing to scrub, and
// we keep it that way (the traces-prune posture — never put sensitive content
// on a span rather than scrub it out; the span-scrub transcript denylist is
// the backstop, not the plan).

const tracer = trace.getTracer("retention");

@Processor(TRANSCRIPT_PRUNE_QUEUE, { concurrency: TRANSCRIPT_PRUNE_CONCURRENCY })
export class TranscriptPruneProcessor extends WorkerHost {
  constructor(private readonly retention: TranscriptRetentionService) {
    super();
  }

  async process(job: Job): Promise<{ deleted: number }> {
    return tracer.startActiveSpan("retention.transcript-prune.process", async (span) => {
      try {
        const { deleted, cutoff } = await this.retention.prune();

        // Safe, non-transcript attributes only (see the header note): the
        // volume pruned, the cutoff age, and the configured window. None of
        // these is Tier-2 transcript content.
        span.setAttribute("retention.pruned.count", deleted);
        span.setAttribute("retention.cutoff", cutoff.toISOString());
        span.setAttribute("retention.window.days", AGENT_TRANSCRIPT_RETENTION_DAYS);
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
