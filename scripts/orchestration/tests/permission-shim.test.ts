import { describe, it, expect } from "vitest";
import { buildPermissionShim } from "../src/permission-shim.js";

// Regression: @anthropic-ai/claude-agent-sdk@0.1.77 rejects an `allow`
// response that omits `updatedInput`. Iter 1 of the Phase 1 Vehicles slice
// (2026-05-21) halted with no PR because every Write / Edit / state-changing
// Bash got a Zod `invalid_union` from the SDK. The shim must pass
// `updatedInput` on every allow path. These tests fail if any allow path
// drops it.

describe("permission shim — allow shape always includes updatedInput", () => {
  const shim = buildPermissionShim({ iteration: 1 });

  it("Bash allow includes updatedInput passed through", async () => {
    const input = { command: "git status" };
    const result = await shim("Bash", input);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toBeDefined();
      expect(result.updatedInput).toEqual(input);
    }
  });

  it("Bash blocklisted command denies (does NOT need updatedInput on deny)", async () => {
    const result = await shim("Bash", { command: "rm -rf /tmp/test" });
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("Destructive Bash blocked");
    }
  });

  it("Write tool allow includes updatedInput", async () => {
    const input = { file_path: "/tmp/x.txt", content: "hello" };
    const result = await shim("Write", input);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual(input);
    }
  });

  it("Edit tool allow includes updatedInput", async () => {
    const input = { file_path: "/tmp/x.txt", old_string: "a", new_string: "b" };
    const result = await shim("Edit", input);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual(input);
    }
  });

  it("Read tool allow includes updatedInput", async () => {
    const input = { file_path: "/tmp/x.txt" };
    const result = await shim("Read", input);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual(input);
    }
  });

  it("unknown tool name still gets allow with updatedInput", async () => {
    const input = { arbitrary: "field" };
    const result = await shim("SomeFutureTool", input);
    expect(result.behavior).toBe("allow");
    if (result.behavior === "allow") {
      expect(result.updatedInput).toEqual(input);
    }
  });

  it("AskUserQuestion denies with auto-answer message (no updatedInput needed)", async () => {
    const input = {
      questions: [
        {
          question: "X?",
          header: "X",
          multiSelect: false,
          options: [{ label: "Yes (Recommended)" }, { label: "No" }],
        },
      ],
    };
    const result = await shim("AskUserQuestion", input);
    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.message).toContain("Auto-answered");
      expect(result.message).toContain("Recommended");
    }
  });
});
