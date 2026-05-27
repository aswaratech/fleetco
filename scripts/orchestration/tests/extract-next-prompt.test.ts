import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  extractNextPrompt,
  extractTier1,
  extractTier2,
  isNextPromptTooShort,
  MIN_NEXT_PROMPT_LENGTH,
} from "../src/extract-next-prompt.js";
import type { HaikuExtractor, PrBodyFetcher } from "../src/extract-next-prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (name: string) => readFileSync(path.join(here, "fixtures", name), "utf8");

describe("extractNextPrompt — four-tier extractor", () => {
  describe("Tier 1: heading anchor + fenced body", () => {
    it("extracts the fenced block under `## Next-session prompt`", async () => {
      const t = fix("transcript-heading-fenced.md");
      const r = await extractNextPrompt(t);
      expect(r.tier).toBe(1);
      expect(r.prompt).toContain("## Ticket");
      expect(r.prompt).toContain("Husky and lint-staged");
      // Should NOT contain the narrative text from outside the next-prompt section.
      expect(r.prompt).not.toContain("That's all from this iteration");
    });

    it("extractTier1 alone returns the body of the heading section", () => {
      const t = fix("transcript-heading-fenced.md");
      const r = extractTier1(t);
      expect(r).not.toBeNull();
      expect(r!).toContain("Husky and lint-staged");
    });
  });

  describe("Tier 1: heading anchor + blockquote body", () => {
    it("extracts the blockquote block, stripping `> ` prefixes", async () => {
      const t = fix("transcript-heading-blockquote.md");
      const r = await extractNextPrompt(t);
      expect(r.tier).toBe(1);
      expect(r.prompt).toContain("Initialize Prisma");
      expect(r.prompt).not.toContain("> ## Program"); // `> ` prefix stripped
      expect(r.prompt).toContain("## Program");
      // Should NOT contain "End of iteration." (outside the blockquote run).
      expect(r.prompt).not.toContain("End of iteration");
    });
  });

  describe("Tier 2: trailing fenced block (no heading)", () => {
    it("extracts the last fenced block when no heading anchor exists", async () => {
      const t = fix("transcript-trailing-fenced.md");
      const r = await extractNextPrompt(t);
      // This fixture says "The next ticket:" then a fenced block, but no
      // "## Next-session prompt" heading — so Tier 1 misses, Tier 2 catches.
      expect(r.tier).toBe(2);
      expect(r.prompt).toContain("Implement the Vehicles list");
    });

    it("extractTier2 returns the last fenced block specifically", () => {
      const transcript = "```\nblock 1\n```\nsome text\n```\nblock 2\n```\n";
      expect(extractTier2(transcript)).toBe("block 2");
    });

    it("extractTier2 returns null if no fenced blocks exist", () => {
      expect(extractTier2("no fenced blocks here at all")).toBeNull();
    });
  });

  describe("Tier 3: PR body fallback (agent put the prompt in PR description)", () => {
    // The motivating failure: an agent opened a PR successfully, wrote a
    // thoughtful next-session prompt inside the PR description body, but
    // emitted no `## Next-session prompt` heading or trailing fenced block in
    // its assistant transcript. Tiers 1 and 2 miss; tier 3 fetches the PR
    // body and re-runs the same heading + fenced-block extractors against it.
    const transcriptWithoutPrompt =
      "Iter 5 shipped. PR #29 opened. The next-session prompt for iter 6 is in the PR description body.";

    it("extracts the prompt from a PR body that has the heading + fenced block", async () => {
      const prBody = [
        "## Summary",
        "Iter 5 work landed.",
        "",
        "## Next-session prompt",
        "",
        "```",
        "## Ticket — iter 6",
        "Drivers slice read path.",
        "```",
      ].join("\n");
      const fetcher: PrBodyFetcher = vi.fn(async () => prBody);
      const r = await extractNextPrompt(transcriptWithoutPrompt, { prBodyFetcher: fetcher });
      expect(r.tier).toBe(3);
      expect(r.prompt).toContain("Drivers slice read path");
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("falls back to tier-2-on-body when the PR body has only a trailing fenced block", async () => {
      const prBody = [
        "## Summary",
        "Iter 5 work landed.",
        "",
        "Iter 6 should add the Drivers slice. The plan is:",
        "",
        "```",
        "Drivers slice read path.",
        "```",
      ].join("\n");
      const fetcher: PrBodyFetcher = vi.fn(async () => prBody);
      const r = await extractNextPrompt(transcriptWithoutPrompt, { prBodyFetcher: fetcher });
      expect(r.tier).toBe(3);
      expect(r.prompt).toContain("Drivers slice read path");
    });

    it("falls through to Haiku (tier 4) when the fetcher returns null", async () => {
      const fetcher: PrBodyFetcher = vi.fn(async () => null);
      const haiku: HaikuExtractor = vi.fn(async () => "## Ticket\n\nFrom Haiku.");
      const r = await extractNextPrompt(transcriptWithoutPrompt, {
        prBodyFetcher: fetcher,
        haikuExtractor: haiku,
      });
      expect(r.tier).toBe(4);
      expect(r.prompt).toContain("From Haiku");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(haiku).toHaveBeenCalledOnce();
    });

    it("falls through to Haiku (tier 4) when the fetcher throws", async () => {
      const fetcher: PrBodyFetcher = vi.fn(async () => {
        throw new Error("gh down");
      });
      const haiku: HaikuExtractor = vi.fn(async () => "## Ticket\n\nFrom Haiku.");
      const r = await extractNextPrompt(transcriptWithoutPrompt, {
        prBodyFetcher: fetcher,
        haikuExtractor: haiku,
      });
      expect(r.tier).toBe(4);
      expect(r.prompt).toContain("From Haiku");
    });

    it("falls through when the PR body itself has no extractable prompt", async () => {
      const prBody = "## Summary\n\nIter 5 work landed. No next-prompt drafted.";
      const fetcher: PrBodyFetcher = vi.fn(async () => prBody);
      const haiku: HaikuExtractor = vi.fn(async () => null);
      const r = await extractNextPrompt(transcriptWithoutPrompt, {
        prBodyFetcher: fetcher,
        haikuExtractor: haiku,
      });
      expect(r.tier).toBeNull();
      expect(r.prompt).toBe("");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(haiku).toHaveBeenCalledOnce();
    });
  });

  describe("Tier 4: AI fallback for transcripts with no clear prompt", () => {
    it("returns NONE for the no-next-prompt fixture (no relevant keywords)", async () => {
      const t = fix("transcript-no-next-prompt.md");
      // This fixture does say "next-session prompt" once ("I did not draft a next-session prompt"), so
      // the gate is open. But Tiers 1, 2, and 3 (skipped — no fetcher) all miss. So Tier 4 fires.
      const haikuShouldReturnNone: HaikuExtractor = vi.fn(async () => null);
      const r = await extractNextPrompt(t, { haikuExtractor: haikuShouldReturnNone });
      expect(r.tier).toBeNull();
      expect(r.prompt).toBe("");
      expect(haikuShouldReturnNone).toHaveBeenCalledOnce();
    });

    it("returns Tier 4 result if Haiku finds something", async () => {
      const transcript =
        "Iteration done. Wait, I forgot to write a clear next-session prompt. " +
        "But the next iteration should add the Drivers slice. Open a PR. Draft next-session prompt.";
      const haikuFinds: HaikuExtractor = vi.fn(async () => "## Ticket\n\nAdd the Drivers slice.");
      const r = await extractNextPrompt(transcript, { haikuExtractor: haikuFinds });
      expect(r.tier).toBe(4);
      expect(r.prompt).toContain("Drivers slice");
    });

    it("skips Tier 4 if transcript has no relevant keywords (saves a Haiku call)", async () => {
      const transcript = "Just some random output with no mention of the relevant phrases.";
      const haikuMustNotBeCalled: HaikuExtractor = vi.fn(async () => "something");
      const r = await extractNextPrompt(transcript, { haikuExtractor: haikuMustNotBeCalled });
      expect(r.tier).toBeNull();
      expect(haikuMustNotBeCalled).not.toHaveBeenCalled();
    });

    it("returns NONE if Haiku throws", async () => {
      const transcript = "I'll write the next-session prompt now. (but doesn't)";
      const haikuThrows: HaikuExtractor = vi.fn(async () => {
        throw new Error("haiku down");
      });
      const r = await extractNextPrompt(transcript, { haikuExtractor: haikuThrows });
      expect(r.tier).toBeNull();
    });
  });

  describe("ordering: Tier 1 wins over Tier 2 even if both match", () => {
    it("prefers heading-anchored block over later trailing fenced blocks", async () => {
      const transcript = `## Next-session prompt

\`\`\`
HEADING_ANCHORED_BLOCK
\`\`\`

Some other narrative.

\`\`\`
LATER_FENCED_BLOCK_THAT_SHOULD_BE_IGNORED
\`\`\`
`;
      const r = await extractNextPrompt(transcript);
      expect(r.tier).toBe(1);
      expect(r.prompt).toBe("HEADING_ANCHORED_BLOCK");
    });
  });
});

describe("isNextPromptTooShort — length floor", () => {
  // The floor catches agent-compressed next-prompts that dropped the
  // structural / hardening sections. The actual iter-13→iter-14 failure
  // was a 2101-char prompt; a complete operator kickoff is ~8–9k chars.

  it("flags a prompt below the floor as too short", () => {
    const thin = "x".repeat(MIN_NEXT_PROMPT_LENGTH - 1);
    expect(isNextPromptTooShort(thin)).toBe(true);
  });

  it("flags the real iter-14 failure size (2101 chars)", () => {
    // Regression pin: the actual compressed prompt that halted iter 14.
    expect(isNextPromptTooShort("y".repeat(2101))).toBe(true);
  });

  it("passes a prompt exactly at the floor", () => {
    const atFloor = "z".repeat(MIN_NEXT_PROMPT_LENGTH);
    expect(isNextPromptTooShort(atFloor)).toBe(false);
  });

  it("passes a full-length operator kickoff (~9k chars)", () => {
    const full = "k".repeat(9000);
    expect(isNextPromptTooShort(full)).toBe(false);
  });

  it("does NOT flag an empty prompt (that's the distinct missing case)", () => {
    // An empty / whitespace-only prompt is next_prompt_missing, handled
    // by the caller's `!extracted.prompt` check before the floor runs.
    // isNextPromptTooShort must return false for empty so the two halt
    // milestones stay distinct.
    expect(isNextPromptTooShort("")).toBe(false);
    expect(isNextPromptTooShort("   \n  ")).toBe(false);
  });

  it("measures the trimmed length (leading/trailing whitespace doesn't pad)", () => {
    // A prompt that is short once trimmed should still be flagged even
    // if whitespace padding pushes its raw length over the floor.
    const padded = " ".repeat(MIN_NEXT_PROMPT_LENGTH) + "short body" + " ".repeat(100);
    expect(isNextPromptTooShort(padded)).toBe(true);
  });
});
