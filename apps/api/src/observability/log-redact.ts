// The pino log-redaction denylist — the single source of truth for which keys
// are masked (censored to "[Redacted]") in every API log line. Extracted from
// app.module.ts so the denylist is importable and unit-testable
// (apps/api/test/log-redaction.test.ts).
//
// pino / fast-redact path semantics (load-bearing): a `*.<key>` path matches
// `<key>` exactly ONE level under a wrapper object (e.g. `{ driver: { phone } }`
// → masked), NOT a top-level `{ phone }` and NOT arbitrary nesting depth. The
// redaction test therefore logs a NESTED object.

export const LOG_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.token",
  "*.secret",
  "*.email",
  "*.fullName",
  "*.licenseNumber",
  "*.phone",
  "*.contactPerson",
  "*.dateOfBirth",
  // GPS telematics location keys (ADR-0029 commitment 12 / ADR-0027
  // commitment 5). The GpsPing coordinate + movement fields are Tier 5 (a raw
  // location trail) and MUST NOT appear in logs. These land ATOMICALLY with the
  // GpsPing schema (same PR) so a ping is never loggable before its keys are
  // denylisted. The `*.<key>` wildcard matches the key one level under a
  // wrapper object (same form as *.fullName above).
  //
  // KEEP IN SYNC: the ADR-0026 span-scrub denylist is the OTHER egress layer
  // these same keys must be scrubbed from. That seam EXISTS —
  // apps/api/src/observability/span-scrub.ts exports GPS_SPAN_SCRUB_DENYLIST
  // (this exact key set, minus the `*.` wildcard prefix) and its
  // GpsSpanScrubProcessor deletes those keys from every span before OTLP egress
  // (wired at index 0 in otel.ts's buildOtlpSpanProcessors). Adding a
  // coordinate/movement key here MUST add it there too — the two layers (logs
  // here, spans there) are the pair ADR-0027 commitment 5 names.
  "*.latitude",
  "*.longitude",
  "*.lat",
  "*.lng",
  "*.lon",
  "*.altitude",
  "*.heading",
  "*.speed",
  "*.coordinates",
  "*.geometry",
  "*.location",
  "*.point",
  "*.position",
];

export const LOG_REDACT_CENSOR = "[Redacted]";
