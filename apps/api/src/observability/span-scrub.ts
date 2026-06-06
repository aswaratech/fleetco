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
  "coordinates",
  "geometry",
  "location",
  "point",
  "position",
] as const;

/**
 * An OpenTelemetry `SpanProcessor` that deletes every GPS Tier-5 attribute
 * (the `GPS_SPAN_SCRUB_DENYLIST` keys) from a span's attributes at `onEnd`,
 * before the span is exported (ADR-0026 commitment 5 / ADR-0027 commitment 5).
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
    for (const key of GPS_SPAN_SCRUB_DENYLIST) {
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
