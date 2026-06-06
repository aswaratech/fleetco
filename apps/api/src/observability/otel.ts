import { isSpanContextValid, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace-node";

import { GpsSpanScrubProcessor } from "./span-scrub";

// FleetCo-authored OpenTelemetry seams (ADR-0024). The API does NOT stand
// up its own OpenTelemetry NodeSDK: Sentry v9's `Sentry.init()` already owns
// the global TracerProvider, registers Sentry's span processor on it, and
// auto-instruments HTTP, Prisma and Redis (ADR-0024 commitments 1, 2 & 4 —
// Sentry's `redisIntegration` wraps `@opentelemetry/instrumentation-ioredis`
// itself, so no ioredis instrumentation is registered here). These two pure
// helpers are the only OpenTelemetry surface FleetCo writes by hand; the
// rest is delegated to that Sentry-owned setup. They are deliberately pure
// (no env reads, no I/O) so they can be unit-tested in isolation from the
// bootstrap. `main.ts` and `app.module.ts` wire them in.

/**
 * Build the env-gated OpenTelemetry span processors that extend Sentry's
 * TracerProvider (ADR-0024 commitments 1 & 3). `main.ts` hands the result to
 * `Sentry.init`'s `openTelemetrySpanProcessors`, so any processor returned
 * here runs *in addition to* Sentry's own span processor: spans fan out to
 * both Sentry and the configured OTLP collector.
 *
 * Returns an empty array when `endpoint` is undefined or empty — the no-op
 * posture that mirrors the `SENTRY_DSN` guard in `main.ts`. With no endpoint
 * configured (the Phase-1 default), the API constructs no OTLP exporter and
 * ships no OTLP telemetry (and so there is nothing to scrub for OTLP).
 *
 * When an endpoint is set, returns two processors in order: the
 * `GpsSpanScrubProcessor` at **index 0**, then the OTLP/HTTP
 * `BatchSpanProcessor`. The scrub processor leads the array on purpose —
 * OpenTelemetry runs processors in registration order, so it deletes the GPS
 * Tier-5 attributes (ADR-0026 commitment 5 / ADR-0027 commitment 5) from each
 * span's `onEnd` before the `BatchSpanProcessor` reads them for export,
 * guaranteeing no coordinate ever leaves the process in a span. See
 * `span-scrub.ts` (the OTLP-egress twin of the pino `redact` GPS denylist).
 *
 * `endpoint` is the full OTLP/HTTP **traces** URL (e.g.
 * `https://collector.example.com/v1/traces`), passed verbatim to the
 * exporter's `url` option — not the OTel-base endpoint that would have
 * `/v1/traces` appended. The Phase-2 backend ADR (see ADR-0024 "Revisit
 * when") pins the exact collector URL and sampling policy when a tracing
 * backend is chosen; until then this exporter is wired but dormant.
 */
export function buildOtlpSpanProcessors(endpoint: string | undefined): SpanProcessor[] {
  if (!endpoint) {
    return [];
  }
  const exporter = new OTLPTraceExporter({ url: endpoint });
  // Scrub processor FIRST (index 0), exporter SECOND: the scrub's onEnd must
  // run before the BatchSpanProcessor reads attributes for OTLP egress.
  return [new GpsSpanScrubProcessor(), new BatchSpanProcessor(exporter)];
}

/**
 * pino `mixin` that correlates every log line with the active OpenTelemetry
 * trace (ADR-0024 commitment 5). Wired into `LoggerModule.forRoot`'s
 * `pinoHttp` config in `app.module.ts`.
 *
 * Returns `{ trace_id, span_id }` from the active span's context when one
 * exists and is valid; returns `{}` otherwise — e.g. the bootstrap log line,
 * any log emitted outside a request, or the Phase-1 local-dev default where
 * neither `SENTRY_DSN` nor `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so Sentry/OTel
 * never initialises and there is no active span.
 *
 * The trace/span ids are random hex identifiers (Tier 4 per ADR-0013), safe
 * to log. This complements — it does not replace — nestjs-pino's `genReqId`
 * request id (ADR-0018), which continues to appear on every line.
 */
export function otelTraceMixin(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) {
    return {};
  }
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) {
    return {};
  }
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
