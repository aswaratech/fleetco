import { describe, expect, test } from "vitest";

import {
  buildUngroundedClaimNotice,
  checkUngroundedClaim,
  UNGROUNDED_CLAIM_STATUS,
  UNGROUNDED_CLAIM_TOOL_NAME,
} from "../src/modules/agent/ungrounded-claim-guard";

// Pure unit tests for the guard's regex/grounding logic in isolation — no DB,
// no registry, no MockLlmClient (see agent-loop.test.ts for the end-to-end
// replay of the real incident this guards against). Mirrors the
// agent-redaction.test.ts precedent for the similarly pure redactForModel.

function succeeded(toolName: string, resultEntityId: string) {
  return { toolName, status: "succeeded", resultEntityId };
}
function failed(toolName: string) {
  return { toolName, status: "failed", resultEntityId: null };
}

describe("checkUngroundedClaim", () => {
  test("empty content is never flagged", () => {
    expect(checkUngroundedClaim("", [])).toEqual({ flagged: false, rule: null, excerpt: null });
    expect(checkUngroundedClaim("   ", [])).toEqual({ flagged: false, rule: null, excerpt: null });
  });

  test("plain conversational text with no write-completion verb is never flagged", () => {
    const result = checkUngroundedClaim("Here's a summary of your fleet costs this month.", []);
    expect(result.flagged).toBe(false);
  });

  describe("Rule A — write-completion language, nothing succeeded this turn", () => {
    test("flags a claim with an id when zero actions happened", () => {
      const result = checkUngroundedClaim("Added! See /drivers/cabcdefghij0123456789012.", []);
      expect(result).toEqual({ flagged: true, rule: "A", excerpt: expect.any(String) });
    });

    test("flags a claim with NO id mentioned at all", () => {
      const result = checkUngroundedClaim("Done, I've created it for you.", []);
      expect(result.flagged).toBe(true);
      expect(result.rule).toBe("A");
    });

    test("flags when the only actions this turn are READS (no create/update succeeded)", () => {
      const result = checkUngroundedClaim("Added the driver.", [succeeded("list_vehicles", "")]);
      // list_vehicles doesn't match create_*/update_*, so it grounds nothing.
      expect(result.flagged).toBe(true);
      expect(result.rule).toBe("A");
    });

    test("flags when the only action this turn FAILED", () => {
      const result = checkUngroundedClaim("Added the driver.", [failed("create_driver")]);
      expect(result.flagged).toBe(true);
      expect(result.rule).toBe("A");
    });
  });

  describe("Rule B — something succeeded, but the claim doesn't match it", () => {
    test("flags a claim citing an id that doesn't match any succeeded write this turn", () => {
      const result = checkUngroundedClaim(
        "Also added a driver at /drivers/cnomatch00000000000000001.",
        [succeeded("create_vehicle", "creal000000000000000000001")],
      );
      expect(result.flagged).toBe(true);
      expect(result.rule).toBe("B");
    });

    test("does NOT flag when the cited id matches a real succeeded write this turn", () => {
      const result = checkUngroundedClaim(
        "Updated the vehicle — see /vehicles/creal000000000000000000001.",
        [succeeded("update_vehicle", "creal000000000000000000001")],
      );
      expect(result.flagged).toBe(false);
    });

    test("does NOT flag write-completion language with no id when something DID succeed this turn", () => {
      // A narrower guarantee than Rule A: once at least one real write is on
      // the books this turn, an id-less claim is not independently checkable
      // against "which" write it refers to, so it is left alone — a named,
      // accepted gap (see the module doc comment).
      const result = checkUngroundedClaim("Added it for you!", [
        succeeded("create_vehicle", "creal000000000000000000001"),
      ]);
      expect(result.flagged).toBe(false);
    });
  });

  describe("the negation window", () => {
    test("an unnegated match at the start of content still has a window (no crash on index 0)", () => {
      const result = checkUngroundedClaim("Added it.", []);
      expect(result.flagged).toBe(true);
    });

    test("'could not be added' is recognized as negated and not flagged", () => {
      const result = checkUngroundedClaim(
        "The driver could not be added because the license number is required.",
        [],
      );
      expect(result.flagged).toBe(false);
    });

    test("negation outside the window does not suppress a real claim later in the text", () => {
      const padding = "x".repeat(40);
      const result = checkUngroundedClaim(`Not sure why, but ${padding} added the driver.`, []);
      expect(result.flagged).toBe(true);
    });
  });

  describe("the domain-language exclusion", () => {
    test("'registered' alone never triggers signal 1 (excluded — see module doc comment)", () => {
      const result = checkUngroundedClaim("You have 2 vehicles registered in the fleet.", []);
      expect(result.flagged).toBe(false);
    });
  });

  describe("id extraction", () => {
    test("recognizes entity app paths for every write-capable route", () => {
      for (const prefix of [
        "vehicles",
        "drivers",
        "customers",
        "jobs",
        "trips",
        "fuel-logs",
        "expense-logs",
        "service-records",
      ]) {
        const id = "cmatch00000000000000000001";
        const result = checkUngroundedClaim(`Created it: /${prefix}/${id}.`, []);
        expect(result.rule).toBe("A"); // nothing succeeded this turn either way
        expect(result.flagged).toBe(true);
      }
    });

    test("recognizes a bare cuid with no path", () => {
      const result = checkUngroundedClaim("Created it, id cabcdefghij0123456789012.", []);
      expect(result.flagged).toBe(true);
    });

    test("a short token that merely starts with 'c' is not mistaken for a cuid", () => {
      // "created" itself starts with "c" — the length-20+ floor keeps this
      // from ever matching as a claimed id on its own.
      const result = checkUngroundedClaim("created", [
        succeeded("create_vehicle", "creal000000000000000000001"),
      ]);
      expect(result.flagged).toBe(false); // no id extracted, nothing to mismatch
    });
  });
});

describe("guard constants and notice text", () => {
  test("the sentinel toolName follows the registry's naming pattern but is not a real tool", () => {
    expect(UNGROUNDED_CLAIM_TOOL_NAME).toBe("agent_ungrounded_claim");
  });

  test("the sentinel status is distinct from every real dispatch outcome", () => {
    expect(UNGROUNDED_CLAIM_STATUS).toBe("flagged");
    expect(["succeeded", "failed", "denied"]).not.toContain(UNGROUNDED_CLAIM_STATUS);
  });

  test("the notice explains the claim is unconfirmed and points at the activity ledger", () => {
    const notice = buildUngroundedClaimNotice();
    expect(notice).toContain("unconfirmed");
    expect(notice).toContain("/agent/activity");
  });
});
