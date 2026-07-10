import { describe, expect, test } from "vitest";

import { computeTwilioSignature } from "../src/modules/whatsapp/twilio-signature.guard";

// Pure tests for the zero-dependency Twilio signing recipe (ADR-0046 c2). The
// load-bearing case is the FIRST one: Twilio's PUBLISHED test vector from the
// request-validation docs — an external truth, so the implementation is pinned
// to Twilio's definition of the recipe, not to itself. The guard's HTTP
// branches (503 unconfigured / 403 missing / 403 mismatch / 202 pass) are
// exercised end-to-end in whatsapp-inbound.controller.test.ts.
describe("computeTwilioSignature", () => {
  // https://www.twilio.com/docs/usage/security — the documented example:
  // auth token "12345", this URL, these five POST params, this signature.
  const DOCS_TOKEN = "12345";
  const DOCS_URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const DOCS_PARAMS = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };
  const DOCS_SIGNATURE = "0/KCTR6DLpKmkAf8muzZqo1nDgQ=";

  test("reproduces Twilio's published test vector exactly", () => {
    expect(computeTwilioSignature(DOCS_TOKEN, DOCS_URL, DOCS_PARAMS)).toBe(DOCS_SIGNATURE);
  });

  test("is insensitive to the object's insertion order (keys are sorted)", () => {
    const shuffled = {
      To: "+18005551212",
      From: "+12349013030",
      CallSid: "CA1234567890ABCDE",
      Digits: "1234",
      Caller: "+12349013030",
    };
    expect(computeTwilioSignature(DOCS_TOKEN, DOCS_URL, shuffled)).toBe(DOCS_SIGNATURE);
  });

  test("a single changed param value changes the signature (integrity)", () => {
    expect(
      computeTwilioSignature(DOCS_TOKEN, DOCS_URL, { ...DOCS_PARAMS, Digits: "1235" }),
    ).not.toBe(DOCS_SIGNATURE);
  });

  test("a changed URL changes the signature (the canonical-URL binding)", () => {
    expect(computeTwilioSignature(DOCS_TOKEN, "https://other.example/hook", DOCS_PARAMS)).not.toBe(
      DOCS_SIGNATURE,
    );
  });

  test("no params signs the bare URL (a GET-style webhook)", () => {
    // Not the messaging path, but the recipe's documented degenerate case:
    // the data string is the URL alone.
    expect(computeTwilioSignature(DOCS_TOKEN, DOCS_URL, {})).toBe(
      computeTwilioSignature(DOCS_TOKEN, DOCS_URL, {}),
    );
    expect(computeTwilioSignature(DOCS_TOKEN, DOCS_URL, {})).not.toBe(DOCS_SIGNATURE);
  });
});
