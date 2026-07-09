// Canonical E.164 phone-number normalization for the WhatsApp channel
// (ADR-0046 c4). This is the ONE normalizer, imported by BOTH the inbound
// resolver (WhatsAppIdentityService, the read path) and the provisioning script
// (link-whatsapp-number.ts, the write path), so a stored AgentPhoneLink key and
// an inbound number are byte-identical — the coherence guarantee that makes the
// @unique lookup reliable. Sharing one function is the same discipline as the
// shared WKT builder (apps/api/src/common/wkt.ts) between the telematics and
// geofences modules.
//
// STRICT by design. This value is a security key matched at both write and read
// (ADR-0046 c9), so the parse is fail-closed: strip only the Twilio `whatsapp:`
// transport prefix and surrounding whitespace, then require an already-canonical
// E.164 string. Internal separators (spaces, dashes, parentheses) are REJECTED
// with a clear message rather than silently stripped — the write path is a rare,
// deliberate operator action that can type the canonical form, and lenient
// stripping widens the surface over which two inputs might collide or a garbage
// input might slip through. The error message NEVER echoes the raw input: the
// number is Tier-2 PII (ADR-0013) and this function runs on the inbound path,
// where an echoed value could reach a log.

export class InvalidPhoneNumberError extends Error {
  constructor() {
    super("Not a canonical E.164 phone number (expected e.g. +9779812345678).");
    this.name = "InvalidPhoneNumberError";
  }
}

// E.164: a leading `+`, a non-zero country-code digit, then 7–14 more digits
// (8–15 digits total, the E.164 maximum). Anchored; no internal separators.
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizeE164(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^whatsapp:/i, "")
    .trim();
  if (!E164.test(trimmed)) {
    throw new InvalidPhoneNumberError();
  }
  return trimmed;
}
