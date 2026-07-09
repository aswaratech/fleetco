import type { AgentAction, AgentMessage } from "@prisma/client";

// The WhatsApp reply renderer (ADR-0046 commitment 6) — the ADR-0043 c4c
// honesty rule carried onto a text channel. A PURE function of the turn result
// (no DB reads, no clock, no env): the same `AgentTurnResult` the web chat
// consumes renders here as plain text, so on WhatsApp — where there is no
// `/agent/activity` panel in the thread — the server-derived action cards are
// the ADMIN's only in-the-moment way to catch a bad autonomous write.
//
// Three honesty properties, mirrored from the web renderer
// (apps/web/src/app/(app)/chat/chat-client.tsx):
//   • The reply's prose is the model's FINAL assistant message only —
//     intermediate tool-call rounds persist with empty content and render
//     nothing themselves.
//   • Server-authored system notices (turn-budget stops, provider failures,
//     the ungrounded-claim guard) render AS notices, marked as system speech —
//     the transcript must not ventriloquize the model, and the model's text
//     must not absorb the server's.
//   • Every action card renders from the server's AgentAction row, never from
//     model text: tool, status, the changed fields (a write's argsJson keys),
//     and ONE deep-link to the affected record.

/** Twilio's per-message WhatsApp body limit (chunk boundary, ADR-0046 c6). */
export const WHATSAPP_SEGMENT_MAX = 1600;

/** WhatsApp's total message-body ceiling; the rendered reply is truncated to
 * this before chunking (ADR-0046 c6). */
export const WHATSAPP_BODY_MAX = 4096;

/** Appended when the rendered reply exceeds {@link WHATSAPP_BODY_MAX}. */
export const TRUNCATION_NOTICE = "\n… (reply truncated — see the web chat for the rest)";

// The AgentAction entity-type → detail-route map — the SAME table as the web's
// ENTITY_ROUTES (apps/web/src/lib/agent-chat.ts); the two must stay in sync: a
// new write tool's entity adds a row in BOTH (they cannot share code across the
// app boundary, and each side's allowlist is deliberately its own security
// surface). Keys are the Prisma model names the write tools declare as
// `resultEntityType`; every route has a detail page at `<prefix>/[id]`.
const ENTITY_ROUTES: Readonly<Record<string, string>> = {
  Vehicle: "/vehicles",
  Driver: "/drivers",
  Customer: "/customers",
  Job: "/jobs",
  Trip: "/trips",
  FuelLog: "/fuel-logs",
  ExpenseLog: "/expense-logs",
  ServiceRecord: "/service-records",
};

// Fail-closed id gate before an id is embedded in a URL (the web's
// ENTITY_ID_PATTERN): a value that is not a plain record id renders as text,
// never as a link.
const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Status glyphs for the text card head. The status WORD stays authoritative
 * (rendered beside the glyph); the glyph is a phone-screen affordance. */
const STATUS_GLYPHS: Readonly<Record<string, string>> = {
  succeeded: "✓",
  failed: "✕",
  denied: "⛔",
  flagged: "⚠",
};

/** The slices of the turn result the renderer reads — structurally satisfied
 * by the real `AgentTurnResult` (its `messages` / `actions` are the Prisma
 * rows), and cheap to construct in tests. */
export interface RenderableTurn {
  messages: Pick<AgentMessage, "role" | "content">[];
  actions: Pick<
    AgentAction,
    "toolName" | "status" | "argsJson" | "resultEntityType" | "resultEntityId"
  >[];
}

export interface RenderTurnOptions {
  /** The admin web's public base URL (`env.WEB_PUBLIC_URL`) for absolute
   * deep-links. When unset the card shows `<EntityType> <id>` instead — a
   * relative link is useless in a text message (ADR-0046 c6). */
  webPublicUrl?: string;
}

/** How many changed-field names a card lists before eliding the rest. */
const FIELD_LIST_MAX = 8;

function renderActionCard(
  action: RenderableTurn["actions"][number],
  webPublicUrl: string | undefined,
): string {
  const glyph = STATUS_GLYPHS[action.status] ?? "•";
  const lines = [`${glyph} ${action.toolName} — ${action.status}`];

  // Changed-field summary (c6): a WRITE's validated argsJson keys, minus the
  // row-selecting `id`. Only entity-bearing succeeded actions — a read's args
  // are filter noise, and a failed/denied dispatch changed nothing.
  if (
    action.status === "succeeded" &&
    action.resultEntityType !== null &&
    typeof action.argsJson === "object" &&
    action.argsJson !== null &&
    !Array.isArray(action.argsJson)
  ) {
    const keys = Object.keys(action.argsJson).filter((key) => key !== "id");
    if (keys.length > 0) {
      const shown = keys.slice(0, FIELD_LIST_MAX);
      const elided = keys.length - shown.length;
      lines.push(`  fields: ${shown.join(", ")}${elided > 0 ? ` (+${String(elided)} more)` : ""}`);
    }
  }

  // The ONE contextual link to the affected record (the web ActionCard's
  // anti-pattern-#3 rule). Absolute only: URL when the base is configured and
  // the type/id pass the allowlists; the honest `<Type> <id>` text otherwise.
  if (action.resultEntityType !== null && action.resultEntityId !== null) {
    const prefix = ENTITY_ROUTES[action.resultEntityType];
    const path =
      prefix !== undefined && ENTITY_ID_PATTERN.test(action.resultEntityId)
        ? `${prefix}/${action.resultEntityId}`
        : null;
    lines.push(
      path !== null && webPublicUrl !== undefined && webPublicUrl !== ""
        ? `  → ${webPublicUrl.replace(/\/+$/, "")}${path}`
        : `  → ${action.resultEntityType} ${action.resultEntityId}`,
    );
  }

  return lines.join("\n");
}

/**
 * Render one agent turn as the WhatsApp reply body (ADR-0046 c6). Layout, in
 * transcript order: the final assistant prose, then the server's system
 * notices (each marked `⚠ system:` — never blended into model speech), then
 * one text action card per AgentAction. Deterministic and total: a turn with
 * no assistant text and no notices (not produced by the current loop, which
 * always writes one or the other) still yields an honest server-authored
 * fallback rather than an empty body. Truncated to {@link WHATSAPP_BODY_MAX}
 * codepoints; pass the result to {@link chunkWhatsAppBody} for sending.
 */
export function renderTurnForWhatsApp(turn: RenderableTurn, opts?: RenderTurnOptions): string {
  let finalAssistantText: string | null = null;
  for (const message of turn.messages) {
    if (message.role === "assistant" && message.content !== "") {
      finalAssistantText = message.content;
    }
  }
  const notices = turn.messages
    .filter((message) => message.role === "system" && message.content !== "")
    .map((message) => `⚠ system: ${message.content}`);

  const sections: string[] = [];
  if (finalAssistantText !== null) {
    sections.push(finalAssistantText);
  } else if (notices.length === 0) {
    sections.push("The agent returned no reply this turn.");
  }
  if (notices.length > 0) {
    sections.push(notices.join("\n"));
  }
  if (turn.actions.length > 0) {
    sections.push(
      turn.actions.map((action) => renderActionCard(action, opts?.webPublicUrl)).join("\n"),
    );
  }

  const body = sections.join("\n\n");
  const codepoints = Array.from(body);
  if (codepoints.length <= WHATSAPP_BODY_MAX) {
    return body;
  }
  // Codepoint-safe truncation (a UTF-16 slice could split a surrogate pair).
  const marker = Array.from(TRUNCATION_NOTICE);
  return codepoints
    .slice(0, WHATSAPP_BODY_MAX - marker.length)
    .concat(marker)
    .join("");
}

/**
 * Split a rendered reply into Twilio-sized segments (≤ {@link
 * WHATSAPP_SEGMENT_MAX} codepoints each), preferring a newline boundary inside
 * the window so a card is not sliced mid-line. Content-preserving:
 * `chunks.join("") === body` always (the split newline stays at the end of its
 * chunk). Codepoint-based so a boundary never splits a surrogate pair.
 */
export function chunkWhatsAppBody(body: string): string[] {
  const codepoints = Array.from(body);
  if (codepoints.length <= WHATSAPP_SEGMENT_MAX) {
    return [body];
  }
  const chunks: string[] = [];
  let start = 0;
  while (codepoints.length - start > WHATSAPP_SEGMENT_MAX) {
    const window = codepoints.slice(start, start + WHATSAPP_SEGMENT_MAX);
    const lastNewline = window.lastIndexOf("\n");
    // A newline at index 0 would make an empty-content chunk; hard-cut instead.
    const take = lastNewline > 0 ? lastNewline + 1 : WHATSAPP_SEGMENT_MAX;
    chunks.push(codepoints.slice(start, start + take).join(""));
    start += take;
  }
  chunks.push(codepoints.slice(start).join(""));
  return chunks;
}
