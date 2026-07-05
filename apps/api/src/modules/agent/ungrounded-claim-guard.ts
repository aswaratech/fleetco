import { type AgentAction } from "@prisma/client";

// A same-turn, deterministic check that an assistant's FINAL reply (the one
// with no tool_calls, about to be shown to the user) doesn't claim a
// create/update happened when this turn's own dispatched actions don't back
// that claim up. Closes a gap in ADR-0043 c4c's "the model cannot misreport
// what it did" guarantee: that guarantee holds for a REAL write with wrong
// details (a genuine AgentAction row contradicts it), not for a wholly
// fabricated one (no row exists to contradict anything). See the 2026-07-05
// append-only annotation on docs/architecture/decisions/0043-ai-chat-agent.md
// for the incident this guards against.
//
// Two independent signals must BOTH indicate a problem before flagging —
// this is what keeps a genuine read summary ("You have 3 vehicles") safe,
// since it never matches signal 1's verb list in the first place:
//
//   Signal 1 — unnegated write-completion language (a curated verb list,
//   guarded by a negation window so "couldn't add" doesn't match).
//   Signal 2 — grounding: an entity-shaped path/id mentioned in the text is
//   cross-checked against this turn's own successful create/update actions.
//
// This is a regex heuristic, not comprehension: a fabrication that avoids
// every verb below slips through, and a true claim citing an id from OUTSIDE
// this turn's own actions (e.g. referencing an earlier turn's record in the
// same reply) can be flagged as a false positive. It closes the SILENT,
// undiscoverable failure mode — every occurrence is now recorded and
// surfaced on /agent/activity — not the underlying model behavior itself.

// "register(ed)" is deliberately EXCLUDED despite being a natural completion
// verb: it collides with ordinary descriptive domain language far more often
// than it signals a fresh claim ("you have 2 vehicles registered in the
// fleet" is a read summary, not an action report). The real incident's own
// fabricated text used "Added", which this list still catches.
const WRITE_COMPLETION_VERBS_SOURCE =
  "\\b(added|creat(?:ed|ing)|updat(?:ed|ing)|logg(?:ed|ing)|record(?:ed|ing))\\b";

// How far back (characters) to look for a negation before a verb match, so
// "couldn't add", "wasn't able to register" don't count as a claim.
const NEGATION_WINDOW_CHARS = 30;
const NEGATION_PATTERN =
  /\b(not|n't|unable|couldn't|could not|failed to|wasn't able|was not able)\b/i;

// Entity-shaped tokens the model might cite as "proof" of a write: an app
// path for a write-capable aggregate (the resultEntityType set the
// registry's create_*/update_* tools declare, tool.types.ts), or a bare
// cuid (Prisma's default id format: lowercase "c" + 20+ alphanumerics).
const ENTITY_PATH_SOURCE =
  "/(vehicles|drivers|customers|jobs|trips|fuel-logs|expense-logs|service-records)/([A-Za-z0-9_-]{6,})";
const BARE_CUID_SOURCE = "\\bc[a-z0-9]{20,}\\b";

export type UngroundedClaimRule = "A" | "B";

export interface UngroundedClaimResult {
  flagged: boolean;
  rule: UngroundedClaimRule | null;
  /** A short excerpt around the matched claim, for the flagged action's argsJson. */
  excerpt: string | null;
}

const NOT_FLAGGED: UngroundedClaimResult = { flagged: false, rule: null, excerpt: null };

function findUnnegatedWriteClaim(content: string): string | null {
  const verbs = new RegExp(WRITE_COMPLETION_VERBS_SOURCE, "gi");
  let match: RegExpExecArray | null;
  while ((match = verbs.exec(content)) !== null) {
    const windowStart = Math.max(0, match.index - NEGATION_WINDOW_CHARS);
    if (!NEGATION_PATTERN.test(content.slice(windowStart, match.index))) {
      const excerptStart = Math.max(0, match.index - 20);
      const excerptEnd = Math.min(content.length, match.index + match[0].length + 40);
      return content.slice(excerptStart, excerptEnd).trim();
    }
  }
  return null;
}

function extractClaimedIds(content: string): string[] {
  const ids: string[] = [];
  for (const match of content.matchAll(new RegExp(ENTITY_PATH_SOURCE, "g"))) {
    ids.push(match[2]);
  }
  for (const match of content.matchAll(new RegExp(BARE_CUID_SOURCE, "g"))) {
    ids.push(match[0]);
  }
  return ids;
}

/**
 * Check one turn's final assistant message against the actions it actually
 * dispatched. `turnActions` is the turn's complete, ground-truth action
 * history (every AgentAction row written so far this turn, across all
 * rounds) — already assembled by the caller; this function queries nothing.
 */
export function checkUngroundedClaim(
  content: string,
  turnActions: readonly Pick<AgentAction, "toolName" | "status" | "resultEntityId">[],
): UngroundedClaimResult {
  if (content.trim() === "") return NOT_FLAGGED;

  const excerpt = findUnnegatedWriteClaim(content);
  if (excerpt === null) return NOT_FLAGGED;

  const succeededWriteIds = new Set(
    turnActions
      .filter((a) => a.status === "succeeded" && /^(create|update)_/.test(a.toolName))
      .map((a) => a.resultEntityId)
      .filter((id): id is string => id !== null),
  );

  if (succeededWriteIds.size === 0) {
    // Rule A: write-completion language, but nothing this turn actually
    // succeeded — the incident this guard was built for, and the harder
    // case of a fabrication that names no id at all.
    return { flagged: true, rule: "A", excerpt };
  }

  const claimedIds = extractClaimedIds(content);
  if (claimedIds.some((id) => !succeededWriteIds.has(id))) {
    // Rule B: something DID succeed this turn, but at least one id the
    // message cites doesn't match any of those real successes (a mixed
    // real-write-plus-fabrication claim).
    return { flagged: true, rule: "B", excerpt };
  }

  return NOT_FLAGGED;
}

/** The sentinel toolName/status this guard writes to AgentAction — reuses
 * the existing audit table (both columns are open strings, no enum, no
 * migration) rather than adding a new one. */
export const UNGROUNDED_CLAIM_TOOL_NAME = "agent_ungrounded_claim";
export const UNGROUNDED_CLAIM_STATUS = "flagged";

/** The server-authored system notice appended after a flagged message —
 * same pattern as the existing turn-budget notices (never fabricated
 * assistant speech; c4c's honesty rule cuts both ways: the model must not
 * misreport the server, and the server must not ventriloquize the model). */
export function buildUngroundedClaimNotice(): string {
  return (
    "The assistant's previous message describes a change (an id, app path, or " +
    "confirmation phrase) that the system has no record of actually performing " +
    "in this turn. Treat that claim as unconfirmed — check /agent/activity or " +
    "ask the agent to try again."
  );
}
