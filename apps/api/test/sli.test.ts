import { describe, expect, test } from "vitest";

import {
  buildAvailabilitySignal,
  enrichLogWithAvailabilitySignal,
  isAvailabilityGood,
  SLI_API_AVAILABILITY,
  SLI_LATENCY_BUDGET_MS,
} from "../src/common/sli";

// Unit tests for the FleetCo-authored API-availability SLI seams (ADR-0011,
// T_SLI1). Per the ticket we pin the pure helpers — not pino-http's internal
// logging behaviour. Tests run with LOG_LEVEL=fatal, so the contract is
// asserted through the pure functions rather than by capturing emitted logs.

describe("SLI_LATENCY_BUDGET_MS", () => {
  test("is ADR-0011's 500ms latency threshold", () => {
    expect(SLI_LATENCY_BUDGET_MS).toBe(500);
  });
});

describe("isAvailabilityGood", () => {
  // The exact boundary table the ticket specifies.
  test("a fast 2xx is good", () => {
    expect(isAvailabilityGood(200, 100)).toBe(true);
  });

  test("exactly the latency budget is still good (<= boundary)", () => {
    expect(isAvailabilityGood(200, 500)).toBe(true);
  });

  test("one millisecond past the budget is bad", () => {
    expect(isAvailabilityGood(200, 501)).toBe(false);
  });

  test("a fast 3xx redirect is good", () => {
    expect(isAvailabilityGood(301, 100)).toBe(true);
  });

  test("a 4xx is bad even when fast (the API did not serve it successfully)", () => {
    expect(isAvailabilityGood(400, 10)).toBe(false);
  });

  test("a 5xx is bad even when fast", () => {
    expect(isAvailabilityGood(503, 10)).toBe(false);
  });
});

describe("buildAvailabilitySignal", () => {
  test("tags a good request with the api_availability sli and sli_good=true", () => {
    expect(buildAvailabilitySignal(200, 120)).toEqual({
      sli: "api_availability",
      http_status: 200,
      response_time_ms: 120,
      sli_good: true,
    });
  });

  test("a slow 2xx is sli_good=false but still records status and duration", () => {
    expect(buildAvailabilitySignal(200, 900)).toEqual({
      sli: SLI_API_AVAILABILITY,
      http_status: 200,
      response_time_ms: 900,
      sli_good: false,
    });
  });

  test("a 5xx is sli_good=false", () => {
    expect(buildAvailabilitySignal(503, 12)).toEqual({
      sli: SLI_API_AVAILABILITY,
      http_status: 503,
      response_time_ms: 12,
      sli_good: false,
    });
  });
});

describe("enrichLogWithAvailabilitySignal", () => {
  test("merges the signal onto a success completion object using pino-http's responseTime", () => {
    const enriched = enrichLogWithAvailabilitySignal(
      { statusCode: 200 },
      { responseTime: 42, res: { statusCode: 200 } },
    );

    expect(enriched).toMatchObject({
      // preserves pino-http's own completion-object fields …
      responseTime: 42,
      res: { statusCode: 200 },
      // … and adds the SLI signal, latency sourced from val.responseTime (no drift)
      sli: "api_availability",
      http_status: 200,
      response_time_ms: 42,
      sli_good: true,
    });
  });

  test("merges the signal onto an error completion object and preserves err", () => {
    const err = new Error("boom");
    const enriched = enrichLogWithAvailabilitySignal(
      { statusCode: 503 },
      { responseTime: 7, res: { statusCode: 503 }, err },
    );

    expect(enriched).toMatchObject({
      err,
      sli: "api_availability",
      http_status: 503,
      response_time_ms: 7,
      sli_good: false,
    });
  });

  test("defaults response_time_ms to 0 when pino-http supplied no numeric responseTime", () => {
    const enriched = enrichLogWithAvailabilitySignal({ statusCode: 200 }, {});

    expect(enriched).toMatchObject({
      response_time_ms: 0,
      sli_good: true, // a 200 in 0ms is within budget
    });
  });

  test("does not mutate the input completion object", () => {
    const val: Record<string, unknown> = { responseTime: 10 };
    enrichLogWithAvailabilitySignal({ statusCode: 200 }, val);
    expect(val).toEqual({ responseTime: 10 });
  });
});
