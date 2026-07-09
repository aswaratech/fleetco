import { describe, expect, test } from "vitest";

import { InvalidPhoneNumberError, normalizeE164 } from "../src/modules/whatsapp/phone-e164";

// Pure tests for the shared E.164 normalizer (ADR-0046 c4) — no DB, so they
// pin the security primitive independently of Postgres. The load-bearing
// property is COHERENCE: the same function runs at link-write and inbound-resolve,
// so the write path (a bare operator-typed number) and the read path (Twilio's
// `whatsapp:`-prefixed number) must canonicalize to a byte-identical @unique key,
// and every non-canonical input must fail closed rather than partially match.
describe("normalizeE164 (pure)", () => {
  test("strips the Twilio whatsapp: transport prefix", () => {
    expect(normalizeE164("whatsapp:+9779812345678")).toBe("+9779812345678");
  });

  test("accepts an already-canonical number unchanged", () => {
    expect(normalizeE164("+9779812345678")).toBe("+9779812345678");
  });

  test("tolerates surrounding whitespace (and whitespace after the prefix)", () => {
    expect(normalizeE164("  whatsapp:+9779812345678  ")).toBe("+9779812345678");
    expect(normalizeE164("whatsapp: +9779812345678")).toBe("+9779812345678");
  });

  test("is idempotent — normalize(normalize(x)) === normalize(x)", () => {
    const once = normalizeE164("whatsapp:+9779812345678");
    expect(normalizeE164(once)).toBe(once);
  });

  test("write path and read path canonicalize to the SAME key (the coherence guarantee)", () => {
    // The provisioning operator types a bare number; Twilio delivers a prefixed
    // one. Both MUST land on the identical @unique key or the lookup misses.
    expect(normalizeE164("+9779812345678")).toBe(normalizeE164("whatsapp:+9779812345678"));
  });

  test.each([
    // The just-INSIDE length boundaries, asserted as ACCEPTED — symmetric with
    // the "too short (7)" / "too long (16)" reject cases below, so an off-by-one
    // in the /^\+[1-9]\d{7,14}$/ length bound (which would wrongly reject a valid
    // boundary number) cannot slip through.
    ["minimum length (8 digits total)", "+12345678"],
    ["maximum length (15 digits total)", "+123456789012345"],
    ["a typical Nepal mobile (13 digits)", "+9779812345678"],
  ])("accepts %s unchanged", (_label, input) => {
    expect(normalizeE164(input)).toBe(input);
  });

  test.each([
    ["missing +", "9779812345678"],
    ["internal spaces", "+977 981 234 5678"],
    ["internal dashes", "+977-981-234-5678"],
    ["parentheses", "+1 (555) 234 5678"],
    ["leading-zero country code", "+0779812345678"],
    ["letters", "+97798123456AB"],
    ["empty string", ""],
    ["prefix only", "whatsapp:"],
    ["too short (7 digits)", "+1234567"],
    ["too long (16 digits)", "+1234567890123456"],
    ["double prefix", "whatsapp:whatsapp:+9779812345678"],
  ])("rejects %s as fail-closed", (_label, input) => {
    expect(() => normalizeE164(input)).toThrow(InvalidPhoneNumberError);
  });

  test("the error message never echoes the raw input (Tier-2 no-leak)", () => {
    // The number is Tier-2 PII and this runs on the inbound path — an echoed
    // value could reach a log. The message must be a generic format hint.
    try {
      normalizeE164("+977-SECRET-9999");
      expect.unreachable("normalizeE164 should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPhoneNumberError);
      expect((error as Error).message).not.toContain("SECRET");
    }
  });
});
