// Four-tier extractor for the next-session kickoff prompt the agent drafts
// at end-of-session.
//
// Principle 5 from docs/runbook/orchestration-loop-design.md: the agent's
// output format will vary across runs; a single extraction approach will
// silently miss the prompt in a non-trivial fraction of iterations. The four
// tiers are in order of preference (cheapest + most deterministic first);
// without all four, format drift silently halts the loop within ~10
// iterations.
//
// Tier 1: heading anchor "## ... next-session prompt" + following block
//         (fenced code, blockquote, or prose) in the assistant transcript.
// Tier 2: last triple-backtick fenced block in the assistant transcript.
// Tier 3: fetch the just-merged PR's body via `gh pr view --json body` and
//         re-run tier-1 / tier-2 extraction against that text. Handles the
//         case where the agent placed the next-prompt in the PR description
//         instead of the transcript (which halted the loop on the iter that
//         motivated this fallback's introduction). One cheap `gh` call.
// Tier 4: AI fallback (Haiku) over last 20k chars; returns NONE if it can't
//         find a next-session prompt verbatim.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config.js";
import type { ExtractedPrompt } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------- Tier 1: heading anchor ----------

const HEADING_RE = /^##\s+.*next[- ]session\s+prompt.*$/im;
const ANY_H2_RE = /^##\s+/m;

export function extractTier1(transcript: string): string | null {
  const headingMatch = HEADING_RE.exec(transcript);
  if (!headingMatch) return null;
  const afterHeading = transcript.slice(headingMatch.index + headingMatch[0].length);

  // Find the first fenced block in afterHeading. If it starts before any
  // subsequent ## heading, we use it — and importantly, ## lines INSIDE the
  // fenced block (e.g. "## Program") are not treated as section terminators.
  // This is the common shape of agent-drafted kickoff prompts.
  const fencedMatch = /```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/.exec(afterHeading);
  const nextHeading = ANY_H2_RE.exec(afterHeading);
  const nextHeadingIdx = nextHeading?.index ?? afterHeading.length;

  if (fencedMatch && fencedMatch.index < nextHeadingIdx) {
    const body = (fencedMatch[1] ?? "").trim();
    if (body.length > 0) return body;
  }

  // Otherwise clip the section at the next ## heading and look for blockquote/prose.
  const section = afterHeading.slice(0, nextHeadingIdx);

  const blockquote = extractBlockquoteRun(section);
  if (blockquote !== null) return blockquote;

  // Fall through to prose: trim and return non-empty content.
  const prose = section.trim();
  return prose.length > 0 ? prose : null;
}

// ---------- Tier 2: last fenced block ----------

const FENCED_BLOCK_RE = /```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g;

export function extractTier2(transcript: string): string | null {
  let last: string | null = null;
  for (const m of transcript.matchAll(FENCED_BLOCK_RE)) {
    last = (m[1] ?? "").trim();
  }
  return last && last.length > 0 ? last : null;
}

// ---------- Tier 3: PR body fallback ----------

// Fetches the just-merged PR's description body. Returns null on any
// failure (gh missing, PR missing, network blip) — never crashes the
// extractor. The caller wraps this in a closure that binds the prNumber.
export type PrBodyFetcher = () => Promise<string | null>;

export async function defaultPrBodyFetcher(prNumber: number, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", String(prNumber), "--json", "body"],
      { cwd, timeout: 20_000 },
    );
    const parsed = JSON.parse(stdout) as { body?: string };
    const body = parsed.body;
    return typeof body === "string" && body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

// ---------- Tier 4: Haiku fallback ----------

export type HaikuExtractor = (recentTranscript: string) => Promise<string | null>;

let cachedAnthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (cachedAnthropic) return cachedAnthropic;
  cachedAnthropic = new Anthropic({});
  return cachedAnthropic;
}

export const defaultHaikuExtractor: HaikuExtractor = async (recentTranscript) => {
  const client = getAnthropic();
  const sys =
    "You are extracting the agent's next-session kickoff prompt from a transcript. " +
    "If the transcript contains a draft kickoff prompt for the next iteration of an orchestration loop, output it verbatim with no preamble or commentary. " +
    "If no such prompt is present, output exactly the literal text: NONE";
  const resp = await client.messages.create({
    model: env.ORCHESTRATION_HAIKU_MODEL,
    max_tokens: 4096,
    system: sys,
    messages: [{ role: "user", content: `Transcript (tail):\n\n${recentTranscript}` }],
  });
  const text = resp.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text || text === "NONE" || /^NONE\b/i.test(text)) return null;
  return text;
};

// ---------- Public API ----------

export interface ExtractOptions {
  /**
   * Tier 3: fetch the just-merged PR's body. The caller binds the PR number.
   * If omitted, tier 3 is skipped entirely (useful for tests that only
   * exercise the transcript-based tiers).
   */
  prBodyFetcher?: PrBodyFetcher;
  /** Override the Haiku extractor (for tests). */
  haikuExtractor?: HaikuExtractor;
  /** How many trailing characters to feed Haiku. Default 20k. */
  haikuTailChars?: number;
}

export async function extractNextPrompt(
  transcript: string,
  options: ExtractOptions = {},
): Promise<ExtractedPrompt> {
  const tier1 = extractTier1(transcript);
  if (tier1) return { prompt: tier1, tier: 1 };
  const tier2 = extractTier2(transcript);
  if (tier2) return { prompt: tier2, tier: 2 };

  // Tier 3: PR body. Runs before Haiku because it's cheaper (one `gh` call,
  // no API spend) and more deterministic (regex over a typically
  // well-structured PR description). Fetcher failures fall through silently.
  if (options.prBodyFetcher) {
    try {
      const body = await options.prBodyFetcher();
      if (body) {
        const fromBody = extractTier1(body) ?? extractTier2(body);
        if (fromBody) return { prompt: fromBody, tier: 3 };
      }
    } catch {
      // Fetcher failure → continue to Haiku.
    }
  }

  // Tier 4 (Haiku) only worth invoking if the transcript at least mentions
  // "next session" or "next prompt". Saves an API call on transcripts with
  // no signal at all.
  if (!/next[- ]session|next\s+prompt|next\s+kickoff/i.test(transcript)) {
    return { prompt: "", tier: null };
  }
  const haiku = options.haikuExtractor ?? defaultHaikuExtractor;
  const tail = transcript.slice(-(options.haikuTailChars ?? 20_000));
  try {
    const tier4 = await haiku(tail);
    if (tier4) return { prompt: tier4, tier: 4 };
  } catch {
    // Haiku fallback failure → treat as NONE rather than crashing the loop.
  }
  return { prompt: "", tier: null };
}

// ---------- helpers ----------

function extractBlockquoteRun(section: string): string | null {
  const lines = section.split("\n");
  // Find the first blockquote line, then take consecutive ones.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^>\s?/.test(lines[i] ?? "")) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = start;
  while (end < lines.length && /^>\s?|^$/.test(lines[end] ?? "")) {
    // Allow blank lines inside a blockquote run; stop at clearly non-blockquote prose.
    if (/^>\s?/.test(lines[end] ?? "")) end++;
    else if ((lines[end] ?? "").trim() === "") end++;
    else break;
  }
  const body = lines
    .slice(start, end)
    .map((l) => l.replace(/^>\s?/, ""))
    .join("\n")
    .trim();
  return body.length > 0 ? body : null;
}
