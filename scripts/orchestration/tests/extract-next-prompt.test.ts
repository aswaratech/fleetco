import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractNextPrompt, extractTier1, extractTier2 } from "../src/extract-next-prompt.js";
import type { HaikuExtractor } from "../src/extract-next-prompt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fix = (name: string) => readFileSync(path.join(here, "fixtures", name), "utf8");

describe("extractNextPrompt — three-tier extractor", () => {
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

  describe("Tier 3: AI fallback for transcripts with no clear prompt", () => {
    it("returns NONE for the no-next-prompt fixture (no relevant keywords)", async () => {
      const t = fix("transcript-no-next-prompt.md");
      // This fixture does say "next-session prompt" once ("I did not draft a next-session prompt"), so
      // the gate is open. But Tier 1 and Tier 2 both miss. So Tier 3 fires.
      const haikuShouldReturnNone: HaikuExtractor = vi.fn(async () => null);
      const r = await extractNextPrompt(t, { haikuExtractor: haikuShouldReturnNone });
      expect(r.tier).toBeNull();
      expect(r.prompt).toBe("");
      expect(haikuShouldReturnNone).toHaveBeenCalledOnce();
    });

    it("returns Tier 3 result if Haiku finds something", async () => {
      const transcript =
        "Iteration done. Wait, I forgot to write a clear next-session prompt. " +
        "But the next iteration should add the Drivers slice. Open a PR. Draft next-session prompt.";
      const haikuFinds: HaikuExtractor = vi.fn(async () => "## Ticket\n\nAdd the Drivers slice.");
      const r = await extractNextPrompt(transcript, { haikuExtractor: haikuFinds });
      expect(r.tier).toBe(3);
      expect(r.prompt).toContain("Drivers slice");
    });

    it("skips Tier 3 if transcript has no relevant keywords (saves a Haiku call)", async () => {
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
