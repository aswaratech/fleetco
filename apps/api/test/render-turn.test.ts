import { describe, expect, test } from "vitest";

import {
  chunkWhatsAppBody,
  renderTurnForWhatsApp,
  TRUNCATION_NOTICE,
  WHATSAPP_BODY_MAX,
  WHATSAPP_SEGMENT_MAX,
  type RenderableTurn,
} from "../src/modules/whatsapp/render-turn";

// Pure tests for the WhatsApp reply renderer (ADR-0046 c6) — the c4c honesty
// rule over text. No DB, no network: the renderer is a pure function of the
// turn slices, so every honesty property is pinned directly.

function msg(role: string, content: string): RenderableTurn["messages"][number] {
  return { role, content };
}

function action(
  overrides: Partial<RenderableTurn["actions"][number]> = {},
): RenderableTurn["actions"][number] {
  return {
    toolName: "create_vehicle",
    status: "succeeded",
    argsJson: { registrationNumber: "BA 2 KHA 1234", type: "TIPPER" },
    resultEntityType: "Vehicle",
    resultEntityId: "ckvehicle123",
    ...overrides,
  };
}

const WEB = "https://fleet.example.com";

describe("renderTurnForWhatsApp — prose + notice selection", () => {
  test("renders the FINAL non-empty assistant message, skipping empty tool-call rounds", () => {
    const body = renderTurnForWhatsApp({
      messages: [
        msg("user", "add a vehicle"),
        msg("assistant", ""), // tool_calls-only round persists as ""
        msg("tool", '{"result":"…"}'),
        msg("assistant", "Done — the vehicle is registered."),
      ],
      actions: [],
    });
    expect(body).toBe("Done — the vehicle is registered.");
  });

  test("an earlier assistant reply never shadows the final one", () => {
    const body = renderTurnForWhatsApp({
      messages: [
        msg("assistant", "Let me check that."),
        msg("assistant", "Two trips are still open."),
      ],
      actions: [],
    });
    expect(body).toBe("Two trips are still open.");
  });

  test("system notices render AS notices, in order, marked as system speech", () => {
    const body = renderTurnForWhatsApp({
      messages: [
        msg("assistant", "I created the driver."),
        msg("system", "Notice one."),
        msg("system", "Notice two."),
      ],
      actions: [],
    });
    expect(body).toBe("I created the driver.\n\n⚠ system: Notice one.\n⚠ system: Notice two.");
  });

  test("a turn with only a system notice (budget stop before a final reply) renders the notice alone — no fabricated prose", () => {
    const notice =
      "Turn stopped: the 5-round budget for one turn was reached. Ask again to continue.";
    const body = renderTurnForWhatsApp({
      messages: [msg("user", "do the thing"), msg("system", notice)],
      actions: [],
    });
    expect(body).toBe(`⚠ system: ${notice}`);
  });

  test("no assistant text and no notice yields the honest server fallback", () => {
    const body = renderTurnForWhatsApp({ messages: [msg("user", "hi")], actions: [] });
    expect(body).toBe("The agent returned no reply this turn.");
  });
});

describe("renderTurnForWhatsApp — action cards (c4c honesty over text)", () => {
  test("a succeeded write renders tool, status, changed fields (minus id), and the absolute deep-link", () => {
    const body = renderTurnForWhatsApp(
      {
        messages: [msg("assistant", "Created.")],
        actions: [
          action({
            toolName: "update_customer",
            argsJson: { id: "ckcust1", phone: "+9779800000001", address: "Dhading" },
            resultEntityType: "Customer",
            resultEntityId: "ckcust1",
          }),
        ],
      },
      { webPublicUrl: WEB },
    );
    expect(body).toBe(
      "Created.\n\n" +
        "✓ update_customer — succeeded\n" +
        "  fields: phone, address\n" +
        `  → ${WEB}/customers/ckcust1`,
    );
  });

  test("a trailing slash on the web base does not double the path separator", () => {
    const body = renderTurnForWhatsApp(
      { messages: [msg("assistant", "ok")], actions: [action()] },
      { webPublicUrl: `${WEB}/` },
    );
    expect(body).toContain(`→ ${WEB}/vehicles/ckvehicle123`);
    expect(body).not.toContain("com//vehicles");
  });

  test("without WEB_PUBLIC_URL the card shows the honest entity text, never a relative link", () => {
    const body = renderTurnForWhatsApp({
      messages: [msg("assistant", "ok")],
      actions: [action()],
    });
    expect(body).toContain("→ Vehicle ckvehicle123");
    expect(body).not.toContain("/vehicles/");
  });

  test("an unknown entity type falls back to text even when the base URL is configured (allowlist, fail closed)", () => {
    const body = renderTurnForWhatsApp(
      {
        messages: [msg("assistant", "ok")],
        actions: [action({ resultEntityType: "Invoice", resultEntityId: "ckinv1" })],
      },
      { webPublicUrl: WEB },
    );
    expect(body).toContain("→ Invoice ckinv1");
    expect(body).not.toContain(`${WEB}/`);
  });

  test("an id failing the plain-record-id gate never lands in a URL (fail closed)", () => {
    const body = renderTurnForWhatsApp(
      {
        messages: [msg("assistant", "ok")],
        actions: [action({ resultEntityId: "ck../../etc" })],
      },
      { webPublicUrl: WEB },
    );
    expect(body).toContain("→ Vehicle ck../../etc");
    expect(body).not.toContain(`${WEB}/vehicles`);
  });

  test("a read dispatch (no entity) renders the bare card — no fields, no link", () => {
    const body = renderTurnForWhatsApp({
      messages: [msg("assistant", "You have 3 vehicles.")],
      actions: [
        action({
          toolName: "list_vehicles",
          argsJson: { status: ["ACTIVE"] },
          resultEntityType: null,
          resultEntityId: null,
        }),
      ],
    });
    expect(body).toBe("You have 3 vehicles.\n\n✓ list_vehicles — succeeded");
  });

  test("denied and failed dispatches carry their status and no fields line", () => {
    const body = renderTurnForWhatsApp({
      messages: [msg("assistant", "I could not do that.")],
      actions: [
        action({
          toolName: "update_trip",
          status: "denied",
          resultEntityType: null,
          resultEntityId: null,
        }),
        action({
          toolName: "create_driver",
          status: "failed",
          resultEntityType: null,
          resultEntityId: null,
        }),
      ],
    });
    expect(body).toContain("⛔ update_trip — denied");
    expect(body).toContain("✕ create_driver — failed");
    expect(body).not.toContain("fields:");
  });

  test("the ungrounded-claim sentinel renders as a flagged card (the guard's notice explains it)", () => {
    const notice =
      "The assistant's previous message describes a change that the system has no record of actually performing in this turn.";
    const body = renderTurnForWhatsApp({
      messages: [msg("assistant", "Demo driver added!"), msg("system", notice)],
      actions: [
        action({
          toolName: "agent_ungrounded_claim",
          status: "flagged",
          argsJson: { rule: "A", excerpt: "Demo driver added!" },
          resultEntityType: null,
          resultEntityId: null,
        }),
      ],
    });
    expect(body).toContain(`⚠ system: ${notice}`);
    expect(body).toContain("⚠ agent_ungrounded_claim — flagged");
    expect(body).not.toContain("fields:");
  });

  test("an unknown status renders with the neutral glyph and its own status word", () => {
    const body = renderTurnForWhatsApp({
      messages: [msg("assistant", "ok")],
      actions: [action({ status: "retrying", resultEntityType: null, resultEntityId: null })],
    });
    expect(body).toContain("• create_vehicle — retrying");
  });

  test("a long field list elides past 8 with an honest count", () => {
    const argsJson = Object.fromEntries(
      ["id", ...Array.from({ length: 10 }, (_, i) => `field${String(i + 1)}`)].map((k) => [k, "v"]),
    );
    const body = renderTurnForWhatsApp(
      { messages: [msg("assistant", "ok")], actions: [action({ argsJson })] },
      { webPublicUrl: WEB },
    );
    expect(body).toContain(
      "fields: field1, field2, field3, field4, field5, field6, field7, field8 (+2 more)",
    );
    expect(body).not.toContain("field9");
  });
});

describe("renderTurnForWhatsApp — the 4096 ceiling", () => {
  test("a reply over the ceiling truncates codepoint-safely with the notice, never past 4096", () => {
    const body = renderTurnForWhatsApp({
      // 4196 emoji = 4196 codepoints (8392 UTF-16 units) — 100 over the ceiling.
      messages: [msg("assistant", "😀".repeat(WHATSAPP_BODY_MAX + 100))],
      actions: [],
    });
    const codepoints = Array.from(body);
    expect(codepoints.length).toBe(WHATSAPP_BODY_MAX);
    expect(body.endsWith(TRUNCATION_NOTICE)).toBe(true);
    // Codepoint-safe: the cut did not split a surrogate pair.
    const beforeMarker = codepoints[WHATSAPP_BODY_MAX - Array.from(TRUNCATION_NOTICE).length - 1];
    expect(beforeMarker).toBe("😀");
  });

  test("a reply at the ceiling passes through untouched", () => {
    const exact = "x".repeat(WHATSAPP_BODY_MAX);
    const body = renderTurnForWhatsApp({ messages: [msg("assistant", exact)], actions: [] });
    expect(body).toBe(exact);
  });
});

describe("chunkWhatsAppBody", () => {
  test("a short body is a single chunk", () => {
    expect(chunkWhatsAppBody("hello")).toEqual(["hello"]);
  });

  test("chunks are content-preserving (join === body) and each within the segment cap", () => {
    const body = Array.from({ length: 120 }, (_, i) => `line ${String(i)} of the reply`).join("\n");
    const chunks = chunkWhatsAppBody(body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(body);
    for (const chunk of chunks) {
      expect(Array.from(chunk).length).toBeLessThanOrEqual(WHATSAPP_SEGMENT_MAX);
    }
  });

  test("prefers a newline boundary so a card line is not sliced mid-line", () => {
    const body = Array.from({ length: 120 }, (_, i) => `line ${String(i)} of the reply`).join("\n");
    const chunks = chunkWhatsAppBody(body);
    const first = chunks[0];
    if (first === undefined) throw new Error("no chunk");
    expect(first.endsWith("\n")).toBe(true);
  });

  test("a body with no newline hard-cuts at exactly the segment cap", () => {
    const body = "x".repeat(WHATSAPP_SEGMENT_MAX * 2 + 100);
    const chunks = chunkWhatsAppBody(body);
    expect(chunks.map((c) => c.length)).toEqual([WHATSAPP_SEGMENT_MAX, WHATSAPP_SEGMENT_MAX, 100]);
    expect(chunks.join("")).toBe(body);
  });

  test("a hard cut lands between codepoints, never inside a surrogate pair", () => {
    const body = "😀".repeat(WHATSAPP_SEGMENT_MAX + 10); // every codepoint is 2 UTF-16 units
    const chunks = chunkWhatsAppBody(body);
    expect(chunks.join("")).toBe(body);
    const first = chunks[0];
    if (first === undefined) throw new Error("no chunk");
    expect(Array.from(first).length).toBe(WHATSAPP_SEGMENT_MAX);
    expect(Array.from(first).every((cp) => cp === "😀")).toBe(true);
  });
});
