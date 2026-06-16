// FleetCo Service Level Indicator (SLI) vocabulary and pure helpers.
//
// ADR-0011 defines two SLIs, each measured against a 99.0% objective over a
// rolling 28-day window:
//   1. API availability      — % of HTTP requests returning 2xx/3xx within 500ms.
//   2. trip-creation success  — % of trip-creation operations completing
//      without a user-visible error.
//
// This module is the shared, dependency-free home for the SLI signal
// vocabulary and the pure good/bad predicates. It is consumed by:
//   - app.module.ts (T_SLI1) — wires the API-availability signal onto every
//     pino-http request-completion log line (enrichLogWithAvailabilitySignal).
//   - the trips controller (T_SLI2) — adds the trip-creation-success signal,
//     reusing the `sli` field vocabulary established here.
//   - the trips controller (D2, ADR-0034 c9) — also adds the driver-app
//     trip-start-success signal on the PATCH → IN_PROGRESS path.
//   - the performance budget (T_PERF) — reuses SLI_LATENCY_BUDGET_MS so the
//     committed budget doc and the emitted signal cannot drift.
//
// Everything here is pure (no I/O, no env reads, no framework imports) so it
// unit-tests in isolation, mirroring the observability/otel.ts seam pattern
// established by T_OTEL (ADR-0024). The values logged are Tier-4 metadata per
// ADR-0013: status code, duration, and a boolean only — never the request URL,
// query string, or body (a filter query can carry Tier-2 PII such as an email,
// and the pino `redact` list does not cover `req.url`).

/**
 * The latency half of the API-availability SLI (ADR-0011): a request counts as
 * "good" only if it completes within this many milliseconds. 500ms is the
 * threshold ADR-0011 fixes; T_PERF's performance budget quotes the same number,
 * importing this constant rather than re-typing it so the two cannot diverge.
 */
export const SLI_LATENCY_BUDGET_MS = 500;

/**
 * The value of the `sli` field tagging an API-availability signal on a log
 * line. A future 28-day report filters completion logs by this tag. T_SLI2
 * adds a sibling constant for the trip-creation-success signal.
 */
export const SLI_API_AVAILABILITY = "api_availability";

/**
 * The value of the `sli` field tagging a trip-creation-success signal (ADR-0011
 * SLI #2). `TripsController.create` (T_SLI2) wraps the create operation in
 * try/catch and logs one line per attempt carrying this tag plus `sli_good`
 * (true on success, false on a thrown-and-rethrown error) and, on failure,
 * `error_kind` (the exception's class name only — never `err.message`, which
 * the trips FK errors embed the literal vehicle/driver id into per ADR-0013).
 * A future 28-day report filters log lines where `sli === "trip_creation_success"`
 * and computes the SLI as the share with `sli_good === true`. The constant lives
 * here, alongside the API-availability vocabulary, so the controller tags the
 * signal from one shared source rather than a hard-coded string literal.
 */
export const SLI_TRIP_CREATION_SUCCESS = "trip_creation_success";

/**
 * The value of the `sli` field tagging a driver-app trip-start-success signal
 * (ADR-0034 commitment 9). Trip start is the driver app's first business-critical
 * write: the PATCH that transitions a trip to IN_PROGRESS. `TripsController.update`
 * emits one line per trip-start attempt carrying this tag plus `sli_good` (true on
 * success, false on a thrown-and-rethrown error) and, on failure, `error_kind`
 * (the exception's class name only — never `err.message`, which the trips service
 * embeds the literal vehicle/driver id into per ADR-0013). Only the
 * `status === "IN_PROGRESS"` transition is tagged — a notes-only PATCH, a stop
 * (→ COMPLETED), or a cancel is NOT a trip-start. The 99.0% target is ADR-0026
 * commitment 6's provisional one (matching ADR-0011's core-operation SLO, since a
 * failed trip-start blocks a driver from working); this constant only INSTRUMENTS
 * that target — it does not re-set it. Per ADR-0034 c9 the SLI counts server-side
 * failures of trip-start requests that REACH the API (an unreachable API is the
 * cellular network's problem, not this indicator's), so it is defined by the
 * operation, not the caller's role. A future 28-day report filters log lines where
 * `sli === "trip_start_success"` and computes the share with `sli_good === true`.
 */
export const SLI_TRIP_START_SUCCESS = "trip_start_success";

/**
 * The structured per-request signal merged onto a request-completion log line.
 * A future 28-day report filters log lines where `sli === "api_availability"`
 * and computes the SLI as the share with `sli_good === true`.
 */
export interface AvailabilitySignal {
  sli: typeof SLI_API_AVAILABILITY;
  http_status: number;
  response_time_ms: number;
  sli_good: boolean;
}

/**
 * The good/bad predicate for the API-availability SLI: a request is "good" when
 * it returns a non-error status (< 400, i.e. 2xx/3xx) within the latency
 * budget. A 4xx is "bad" because the API failed to serve the request
 * successfully from the user's perspective; a 5xx is a server failure. The
 * `<=` boundary means exactly 500ms still counts as good.
 */
export function isAvailabilityGood(httpStatus: number, responseTimeMs: number): boolean {
  return httpStatus < 400 && responseTimeMs <= SLI_LATENCY_BUDGET_MS;
}

/**
 * Build the API-availability signal object for a completed request from its
 * final status and elapsed time. `sli_good` is derived from `isAvailabilityGood`
 * so the boolean and the threshold constant share a single source of truth.
 */
export function buildAvailabilitySignal(
  httpStatus: number,
  responseTimeMs: number,
): AvailabilitySignal {
  return {
    sli: SLI_API_AVAILABILITY,
    http_status: httpStatus,
    response_time_ms: responseTimeMs,
    sli_good: isAvailabilityGood(httpStatus, responseTimeMs),
  };
}

/**
 * Merge the API-availability signal onto a pino-http request-completion log
 * object. `app.module.ts` wires this in as BOTH `customSuccessObject`
 * (2xx/3xx/4xx) and `customErrorObject` (5xx and thrown errors): pino-http
 * routes 5xx down a separate error path, so both hooks delegate here to
 * guarantee 100% of completed requests carry the signal.
 *
 * These hooks REPLACE the completion object with their return value (pino-http's
 * default provider simply returns the object it is handed), so we spread `val`
 * to preserve pino-http's own fields — the serialized `res`, `responseTime`,
 * and, on the error path, `err` — and add the SLI fields alongside them.
 *
 * Latency is read from `val.responseTime`: the exact value pino-http itself
 * computed and logs. That is why these completion-object hooks are used instead
 * of `customProps` — `customProps(req, res)` is not handed the response time
 * (it would have to recompute it from pino-http's internal start-time symbol)
 * and is invoked at request-start as well as at completion, where it would
 * stamp a not-yet-final status and an unset duration onto request-scoped logs.
 * Sourcing latency from `val.responseTime` here means `response_time_ms`,
 * `sli_good`, and pino-http's own `responseTime` field can never disagree.
 *
 * `res` is typed structurally (only `statusCode` is read) so this module stays
 * free of framework/runtime imports and trivially unit-testable. `val` is
 * untrusted log-object shape, hence `Record<string, unknown>` with a runtime
 * narrowing of `responseTime`.
 */
export function enrichLogWithAvailabilitySignal(
  res: { statusCode: number },
  val: Record<string, unknown>,
): Record<string, unknown> {
  const responseTimeMs = typeof val.responseTime === "number" ? val.responseTime : 0;
  return { ...val, ...buildAvailabilitySignal(res.statusCode, responseTimeMs) };
}
