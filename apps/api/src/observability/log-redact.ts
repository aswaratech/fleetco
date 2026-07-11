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
  // Consignee + site-contact person names (ADR-0047 c6 — the Tier-2 PII
  // amendment for trip dispatch). The consignee/site phones inherit the
  // `*.phone` path above; these two NAME paths are the new coverage the
  // dispatch order (Trip.consigneeName) and the Site aggregate
  // (Site.contactName) need so a person's name never lands in a log line.
  // Same `*.<key>` one-level-under-a-wrapper form as *.fullName above.
  "*.consigneeName",
  "*.contactName",
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
  "*.ignition",
  "*.coordinates",
  "*.geometry",
  "*.location",
  "*.point",
  "*.position",
  // AI-agent transcript keys (ADR-0043 commitments 5/6, ticket A2). Agent chat
  // transcripts are Tier 2 — the user's typed text, the model's replies, tool
  // arguments, and update pre-images can all embed PII — and per c5 the
  // transcript-content keys join this list ATOMICALLY with the AgentConversation
  // / AgentMessage / AgentAction schema (same PR), so a transcript row is never
  // loggable before its keys are denylisted. Field names from schema.prisma:
  // AgentMessage.content, AgentConversation.title, AgentAction.argsJson /
  // previousJson.
  //
  // KEEP IN SYNC: the same bare keys join AGENT_SPAN_SCRUB_DENYLIST in
  // apps/api/src/observability/span-scrub.ts (the OTLP-egress twin), exactly as
  // the GPS block above pairs with GPS_SPAN_SCRUB_DENYLIST.
  "*.content",
  "*.title",
  "*.argsJson",
  "*.previousJson",
];

export const LOG_REDACT_CENSOR = "[Redacted]";
