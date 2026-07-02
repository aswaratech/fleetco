import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-node";

// FleetCo-authored OpenTelemetry span-attribute scrub seam (ADR-0026
// commitment 5 / ADR-0027 commitment 5). This is the OTLP-egress twin of the
// pino `redact` GPS denylist in apps/api/src/app.module.ts: the `redact` list
// scrubs raw GPS coordinates from LOGS; this seam scrubs the SAME keys from
// SPANS before they leave the process. The two layers are the pair ADR-0027
// commitment 5 names — the single "no Tier-5 location data leaves the process"
// rule expressed once for logs and once for traces — and they MUST stay in
// sync. Like otel.ts, this module is deliberately pure (no env reads, no I/O)
// so it can be unit-tested in isolation; `otel.ts` wires it into the OTLP
// processor list and `main.ts` hands that list to Sentry's TracerProvider.

/**
 * The GPS Tier-5 denylist for the SPAN egress layer (ADR-0027 commitment 5).
 *
 * These are the SAME keys as the GPS paths in the pino `redact` block of
 * `apps/api/src/app.module.ts`, minus the `*.` wildcard prefix: `redact`
 * matches a key at any nesting depth inside a structured log record, whereas
 * span attributes are a flat key→value map, so here we match the bare key.
 * `app.module.ts`'s `redact` GPS block is the source list this mirrors;
 * **KEEP IN SYNC** — adding a coordinate/movement key to one egress layer
 * means adding it to the other (ADR-0026 commitment 5: the span-scrub
 * denylist "mirrors and extends the pino `redact` paths").
 */
export const GPS_SPAN_SCRUB_DENYLIST = [
  "latitude",
  "longitude",
  "lat",
  "lng",
  "lon",
  "altitude",
  "heading",
  "speed",
  "ignition",
  "coordinates",
  "geometry",
  "location",
  "point",
  "position",
] as const;

/**
 * The AI-agent transcript denylist for the SPAN egress layer (ADR-0043
 * commitments 5/6, ticket A2) — the OTLP twin of the transcript block in
 * `log-redact.ts`, exactly as GPS_SPAN_SCRUB_DENYLIST twins its GPS block.
 * Agent transcripts are Tier 2 (chat text, tool arguments, update pre-images
 * can all embed PII). The PRIMARY defense is the traces-prune posture — agent
 * code never puts transcript content on a span at all (the transcript-prune
 * worker's span carries only counts/cutoff/window); this denylist is the
 * backstop. Kept SEPARATE from the GPS list above because the GPS list is
 * also consumed on its own (the agent tool-result redaction layer imports it
 * as its coordinate strip basis, ADR-0043 c6). **KEEP IN SYNC** with the
 * `*.content` / `*.title` / `*.argsJson` / `*.previousJson` block in
 * log-redact.ts.
 */
export const AGENT_SPAN_SCRUB_DENYLIST = ["content", "title", "argsJson", "previousJson"] as const;

/**
 * The FULL span-scrub denylist the processor below enforces: every key that
 * must never leave the process on a span, across both egress-sensitive
 * domains (GPS Tier-5 + agent-transcript Tier-2).
 */
export const SPAN_SCRUB_DENYLIST = [
  ...GPS_SPAN_SCRUB_DENYLIST,
  ...AGENT_SPAN_SCRUB_DENYLIST,
] as const;

/**
 * An OpenTelemetry `SpanProcessor` that deletes every scrub-denylisted
 * attribute (the `SPAN_SCRUB_DENYLIST` keys — GPS Tier-5 per ADR-0026/0027,
 * plus the agent-transcript Tier-2 keys per ADR-0043) from a span's
 * attributes at `onEnd`, before the span is exported. (The class keeps its
 * original GPS-derived name — it predates the agent keys, and renaming a
 * wired seam is churn; the denylist consts above are the semantic surface.)
 *
 * It MUST be registered AHEAD of the OTLP `BatchSpanProcessor` — `otel.ts`'s
 * `buildOtlpSpanProcessors` puts it at index 0. OpenTelemetry runs span
 * processors in registration order, so this processor's `onEnd` mutates the
 * span's attributes before the `BatchSpanProcessor`'s `onEnd` reads them for
 * OTLP export; that ordering is what guarantees the exporter never sees a
 * coordinate (ADR-0026 commitment 5: "no span exempt"; the precondition for
 * exporting traces to any real backend).
 *
 * Scrubbing happens entirely at `onEnd`. `onStart`, `forceFlush`, and
 * `shutdown` are no-ops (this processor owns no buffer and no exporter).
 */
export class GpsSpanScrubProcessor implements SpanProcessor {
  onStart(): void {
    // No-op: a span's attributes are not final until it ends, so there is
    // nothing to scrub at start. (The SpanProcessor interface passes the
    // span + parent context here; this processor needs neither.)
  }

  onEnd(span: ReadableSpan): void {
    for (const key of SPAN_SCRUB_DENYLIST) {
      // `span.attributes` is the span's live attribute object (the SDK Span
      // class exposes the underlying record, not a copy), so deleting a key
      // here removes it from what every later processor — including the OTLP
      // BatchSpanProcessor — exports. The attribute index signature is
      // `AttributeValue | undefined`, so `delete` is well-typed; a key that
      // is absent is a harmless no-op.
      delete span.attributes[key];
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
