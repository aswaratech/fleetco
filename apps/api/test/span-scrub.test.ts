import { type Attributes } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { describe, expect, test } from "vitest";

import { buildOtlpSpanProcessors } from "../src/observability/otel";
import { GPS_SPAN_SCRUB_DENYLIST, GpsSpanScrubProcessor } from "../src/observability/span-scrub";

// Unit tests for the GPS Tier-5 span-scrub seam (ADR-0026 commitment 5 /
// ADR-0027 commitment 5) — the OTLP-egress twin of the pino `redact` GPS
// denylist in app.module.ts. Same posture as otel.test.ts: pure unit tests,
// no live OTLP collector. The span fixtures are REAL ReadableSpans obtained by
// round-tripping a span through an InMemorySpanExporter, so no casting through
// `unknown` is needed (the otel.test.ts "properly typed fake" discipline).

/**
 * Build a real, finished `ReadableSpan` carrying `attributes`, by starting and
 * ending a span on a provider whose only processor exports into memory. The
 * returned span's `attributes` is the span's live attribute object, so a
 * scrub processor's `onEnd` mutates exactly what a real exporter would read.
 */
function finishedSpanWith(attributes: Attributes): ReadableSpan {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const span = provider.getTracer("span-scrub-test").startSpan("test-span");
  span.setAttributes(attributes);
  span.end();
  const [finished] = exporter.getFinishedSpans();
  if (!finished) {
    throw new Error("expected exactly one finished span from the in-memory exporter");
  }
  return finished;
}

describe("GpsSpanScrubProcessor", () => {
  test("onEnd deletes every GPS denylist attribute and keeps every safe attribute", () => {
    const span = finishedSpanWith({
      // GPS Tier-5 coordinate/movement keys — every one must be scrubbed.
      latitude: 27.7172,
      longitude: 85.324,
      lat: 27.7,
      lng: 85.3,
      lon: 85.3,
      altitude: 1400,
      heading: 270,
      speed: 62,
      coordinates: "27.7172,85.324",
      geometry: "POINT(85.324 27.7172)",
      location: "Kathmandu depot",
      point: "27.7172 85.324",
      position: "lead",
      // Safe (Tier 1/4) attributes — every one must survive.
      vehicleId: "veh_abc123",
      deleted_count: 42,
      "http.method": "POST",
    });

    new GpsSpanScrubProcessor().onEnd(span);

    for (const key of GPS_SPAN_SCRUB_DENYLIST) {
      expect(span.attributes[key]).toBeUndefined();
    }
    expect(span.attributes).toEqual({
      vehicleId: "veh_abc123",
      deleted_count: 42,
      "http.method": "POST",
    });
  });

  test("onEnd leaves a span carrying only safe attributes untouched", () => {
    const span = finishedSpanWith({
      vehicleId: "veh_1",
      "http.status_code": 202,
      "window.days": 90,
    });

    new GpsSpanScrubProcessor().onEnd(span);

    expect(span.attributes).toEqual({
      vehicleId: "veh_1",
      "http.status_code": 202,
      "window.days": 90,
    });
  });

  test("onEnd is a no-op on a span with no attributes", () => {
    const span = finishedSpanWith({});

    expect(() => new GpsSpanScrubProcessor().onEnd(span)).not.toThrow();
    expect(span.attributes).toEqual({});
  });

  test("scrubs GPS attributes before export when registered ahead of the exporter", () => {
    // The real wiring shape buildOtlpSpanProcessors produces: scrub processor
    // first, exporter second. OTel runs processors in registration order, so
    // the exporter must see already-scrubbed spans. This also exercises the
    // no-op onStart (the provider calls it when the span starts).
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new GpsSpanScrubProcessor(), new SimpleSpanProcessor(exporter)],
    });

    const span = provider.getTracer("span-scrub-test").startSpan("gps-ingest-batch");
    span.setAttributes({
      latitude: 27.7172,
      longitude: 85.324,
      vehicleId: "veh_1",
      batch_size: 50,
    });
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(exported?.attributes).toEqual({ vehicleId: "veh_1", batch_size: 50 });
  });

  test("onStart, forceFlush, and shutdown are no-ops that resolve", async () => {
    const processor = new GpsSpanScrubProcessor();
    expect(processor.onStart()).toBeUndefined();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });
});

describe("buildOtlpSpanProcessors scrub ordering", () => {
  test("returns [] for an undefined endpoint (no OTLP exporter, nothing to scrub)", () => {
    expect(buildOtlpSpanProcessors(undefined)).toEqual([]);
  });

  test("puts the GPS scrub processor at index 0 and the BatchSpanProcessor after it", async () => {
    const processors = buildOtlpSpanProcessors("https://collector.example.com/v1/traces");
    expect(processors).toHaveLength(2);
    expect(processors[0]).toBeInstanceOf(GpsSpanScrubProcessor);
    expect(processors[1]).toBeInstanceOf(BatchSpanProcessor);
    // Release each processor's resources so Vitest exits cleanly.
    await Promise.all(processors.map((processor) => processor.shutdown()));
  });
});
