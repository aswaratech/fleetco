import { trace, TraceFlags, type SpanContext } from "@opentelemetry/api";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, test, vi } from "vitest";

import { buildOtlpSpanProcessors, otelTraceMixin } from "../src/observability/otel";
import { GpsSpanScrubProcessor } from "../src/observability/span-scrub";

// Unit tests for the two FleetCo-authored OpenTelemetry seams (ADR-0024).
// Per the ticket, we pin ONLY these pure helpers — not Sentry's internal
// TracerProvider state. The OTLP export path is not exercised against a real
// backend in Phase 1 (no backend exists yet; ADR-0024 commitment 7 + "costs
// we accept"); these tests assert the env-gating and the log-correlation
// shape, which is the entire FleetCo-owned surface.

describe("buildOtlpSpanProcessors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns no processors when the endpoint is undefined (no-op posture)", () => {
    // Mirrors the SENTRY_DSN guard: unset endpoint -> no exporter, no
    // BatchSpanProcessor, no OTLP telemetry. This is the Phase-1 default.
    expect(buildOtlpSpanProcessors(undefined)).toEqual([]);
  });

  test("returns no processors when the endpoint is an empty string", () => {
    // env.ts coerces an empty `.env` value ("") to undefined, but the helper
    // is independently defensive against "" so the gate holds on its own.
    expect(buildOtlpSpanProcessors("")).toEqual([]);
  });

  test("returns the GPS scrub processor then the OTLP BatchSpanProcessor when an endpoint is set", async () => {
    const processors = buildOtlpSpanProcessors("https://collector.example.com/v1/traces");
    // The scrub processor leads the array (index 0) so it deletes GPS Tier-5
    // attributes before the BatchSpanProcessor reads them for OTLP egress
    // (ADR-0026 c5 / ADR-0027 c5). span-scrub.test.ts proves the deletion.
    expect(processors).toHaveLength(2);
    expect(processors[0]).toBeInstanceOf(GpsSpanScrubProcessor);
    expect(processors[1]).toBeInstanceOf(BatchSpanProcessor);
    // Release each processor's resources so Vitest exits cleanly. shutdown()
    // is a no-op flush here (no spans were ever queued).
    await Promise.all(processors.map((processor) => processor.shutdown()));
  });
});

describe("otelTraceMixin", () => {
  // A syntactically valid W3C trace context: 32-hex traceId, 16-hex spanId.
  const VALID_CONTEXT: SpanContext = {
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    traceFlags: TraceFlags.SAMPLED,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("injects trace_id and span_id from the active span", () => {
    // trace.wrapSpanContext returns a real (non-recording) Span around the
    // context — a properly typed fake, no casting through `unknown` needed.
    const span = trace.wrapSpanContext(VALID_CONTEXT);
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);

    expect(otelTraceMixin()).toEqual({
      trace_id: VALID_CONTEXT.traceId,
      span_id: VALID_CONTEXT.spanId,
    });
  });

  test("returns an empty object when there is no active span", () => {
    // The bootstrap log line, any log outside a request, or the Phase-1
    // local-dev default where Sentry/OTel never initialised.
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(undefined);

    expect(otelTraceMixin()).toEqual({});
  });

  test("returns an empty object when the active span context is invalid", () => {
    // All-zero ids fail isSpanContextValid; the mixin must not emit a bogus
    // (and useless) all-zero trace id into the logs.
    const invalidContext: SpanContext = {
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: TraceFlags.NONE,
    };
    const span = trace.wrapSpanContext(invalidContext);
    vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);

    expect(otelTraceMixin()).toEqual({});
  });
});
