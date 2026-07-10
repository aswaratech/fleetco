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
 * The value of the `sli` field tagging a reminder-delivery signal (ADR-0011's
 * "Revisit when" anticipated this by name; ADR-0038 commitment 8 specifies it).
 * The reminder channel's daily scan enqueues one SEND job per recipient; the
 * send path (`NotificationService.send`) emits one line per attempt carrying this
 * tag plus `sli_good` (true on the provider's accept/ack, false on a
 * thrown-and-rethrown send error) and, on failure, `error_kind` — the exception's
 * class name ONLY, never `err.message`, which can embed the recipient address
 * (Tier-2 PII per ADR-0013), exactly the rule the trip SLIs follow for the
 * vehicle/driver id.
 *
 * THE VALID EVENT IS A SEND ATTEMPT — a `Mailer.send` against a real recipient.
 * A scan that finds nothing to send is NOT a valid event and emits no signal, so
 * an idle day does not inflate the denominator (the "count attempts, not
 * non-attempts" discipline the trip SLIs follow). The target is 99.0% over a
 * rolling 28-day window (ADR-0011's catalog); this constant only INSTRUMENTS it.
 * Like the other Phase-2 SLIs, it emits structured signals now; the 28-day report
 * is a post-deploy operator concern (doubly so — there are no sends to measure
 * until the channel runs in production with a configured provider). A future
 * report filters log lines where `sli === "reminder_delivery"` and computes the
 * share with `sli_good === true`.
 */
export const SLI_REMINDER_DELIVERY = "reminder_delivery";

/**
 * The value of the `sli` field tagging a telematics ping-freshness signal.
 * ADR-0026 commitment 6 NAMED the indicator and set its provisional 95.0%
 * target — deliberately below the 99.0% API SLO because ping delivery rides
 * third-party mobile networks in mountainous Nepal; ADR-0035 commitment 8
 * CONSUMES that target (it does not re-set it) and refines the window to
 * "while a trip is active and the app is foregrounded" — exactly when the D4
 * phone producer runs, so instrumenting the authenticated ingest path IS the
 * window. The ingest controller emits ONE line per ACCEPTED batch carrying
 * this tag plus `sli_good` (the batch's OLDEST fix is within
 * TELEMATICS_FRESH_SECONDS of arrival), `batch_size`, and
 * `max_fix_age_seconds`. NEVER coordinates/speed/heading — fix AGE derives
 * from the timestamp, which ADR-0027 c9 leaves outside Tier 5; the Tier-5
 * fields never enter a log line. THE VALID EVENT IS AN ACCEPTED BATCH — a
 * rejected (400/401/403) batch emits nothing (the "count attempts, not
 * non-attempts" discipline), and the Traccar machine path is NOT tagged (its
 * cadence is the gateway's forward loop, not this producer's — its freshness
 * story is the M-program's). A future 28-day report filters
 * `sli === "telematics_ping_freshness"` and computes the share with
 * `sli_good === true` against the 95.0% target.
 */
export const SLI_TELEMATICS_PING_FRESHNESS = "telematics_ping_freshness";

/**
 * PROVISIONAL freshness bound (seconds): a batch is "fresh" when its oldest
 * fix is at most this old on arrival. 120s covers the D4 producer's flush
 * cadence (~30s batches) with headroom for a retry and a slow cell, without
 * masking a stuck producer. Like the GPS-retention window and the due-soon
 * windows, the NUMBER is the PO's to finalize against real production data
 * (the docs/tech-debt.md owner-level-number pattern); this constant only
 * instruments the indicator.
 */
export const TELEMATICS_FRESH_SECONDS = 120;

/**
 * The structured per-accepted-batch signal the ingest route logs. A future
 * 28-day report filters log lines where `sli === "telematics_ping_freshness"`
 * and computes the SLI as the share with `sli_good === true`.
 */
export interface PingFreshnessSignal {
  sli: typeof SLI_TELEMATICS_PING_FRESHNESS;
  sli_good: boolean;
  batch_size: number;
  max_fix_age_seconds: number;
}

/**
 * Build the freshness signal for an accepted batch from its fix timestamps
 * (the validated ISO strings — the only ping field that may enter a log).
 * `now` is injectable for tests. Ages clamp at 0: a device clock slightly
 * ahead of the server yields a "future" fix, which is a clock-skew artifact,
 * not a stale batch — it must never count against the SLI.
 */
export function buildPingFreshnessSignal(
  timestamps: readonly string[],
  now: Date = new Date(),
): PingFreshnessSignal {
  let maxAgeMs = 0;
  for (const iso of timestamps) {
    const ageMs = now.getTime() - new Date(iso).getTime();
    if (ageMs > maxAgeMs) {
      maxAgeMs = ageMs;
    }
  }
  const maxAgeSeconds = Math.round(maxAgeMs / 1000);
  return {
    sli: SLI_TELEMATICS_PING_FRESHNESS,
    sli_good: maxAgeSeconds <= TELEMATICS_FRESH_SECONDS,
    batch_size: timestamps.length,
    max_fix_age_seconds: maxAgeSeconds,
  };
}

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

/**
 * The structured per-attempt signal logged for one reminder send (ADR-0038 c8),
 * mirroring `AvailabilitySignal`'s shape. `error_kind` is present ONLY on a
 * failed attempt and is the exception's class name — never the message (which can
 * embed the recipient address, Tier-2 PII per ADR-0013).
 */
export interface ReminderDeliverySignal {
  sli: typeof SLI_REMINDER_DELIVERY;
  sli_good: boolean;
  error_kind?: string;
}

/**
 * The good/bad predicate for the reminder-delivery SLI: a send attempt is "good"
 * when it completed without a thrown error (the provider accepted it).
 * `undefined` / `null` means "no error" (a successful send); any other value is
 * the error that was thrown and caught. The boolean and the signal builder share
 * this single source of truth, exactly as `isAvailabilityGood` backs
 * `buildAvailabilitySignal`.
 */
export function isReminderDeliveryGood(error?: unknown): boolean {
  return error === undefined || error === null;
}

/**
 * Build the reminder-delivery signal object for one send attempt. Pass nothing
 * (or `undefined`/`null`) for a successful attempt; pass the caught error for a
 * failed one. On failure, `error_kind` is derived HERE from the error's class
 * name — never its message — so a caller cannot accidentally leak `err.message`
 * (which can embed the Tier-2 recipient address) into the log line. A non-Error
 * throw degrades to `"UnknownError"`, matching the trips controller's inline
 * `err instanceof Error ? err.constructor.name : "UnknownError"`.
 */
export function buildReminderDeliverySignal(error?: unknown): ReminderDeliverySignal {
  if (isReminderDeliveryGood(error)) {
    return { sli: SLI_REMINDER_DELIVERY, sli_good: true };
  }
  return {
    sli: SLI_REMINDER_DELIVERY,
    sli_good: false,
    error_kind: error instanceof Error ? error.constructor.name : "UnknownError",
  };
}
