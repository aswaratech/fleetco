import { describe, it, expect, vi } from "vitest";
import {
  createDetectorState,
  detectPr,
  recordBash,
} from "../src/pr-detection.js";
import type { GhPrLister } from "../src/pr-detection.js";

describe("pr-detection", () => {
  describe("Tier 1: gh pr create output", () => {
    it("parses PR number from gh pr create URL output", async () => {
      const state = createDetectorState();
      // Earlier in the session, agent mentioned prior PRs in narrative (#3, #5).
      recordBash(state, "git status", "On branch feat/x\nnothing to commit, working tree clean\n");
      // Then opened a real PR.
      recordBash(
        state,
        "gh pr create --title 'feat: x' --body 'description'",
        "Creating pull request for feat/x into main in addressanup/fleetco-bootstrap-v3\n\nhttps://github.com/addressanup/fleetco-bootstrap-v3/pull/14\n",
      );
      const ghShouldNotBeCalled: GhPrLister = vi.fn(async () => 999);
      const r = await detectPr(state, { cwd: "/tmp", ghPrLister: ghShouldNotBeCalled });
      expect(r.prNumber).toBe(14);
      expect(r.source).toBe("gh_pr_create_output");
      expect(ghShouldNotBeCalled).not.toHaveBeenCalled();
    });

    it("does NOT pick up PR numbers from narrative text (#3, #5) when last bash was not gh pr create", async () => {
      const state = createDetectorState();
      // Last bash is a `cat` of a doc file that mentions prior PRs.
      recordBash(
        state,
        "cat docs/recent-prs.md",
        "Recent merged PRs: #3 (vehicles schema), #5 (drivers schema), #7 (trips schema)\n",
      );
      const ghShouldNotBeCalled: GhPrLister = vi.fn(async () => null);
      const r = await detectPr(state, { cwd: "/tmp", ghPrLister: ghShouldNotBeCalled });
      expect(r.prNumber).toBeNull();
      expect(r.source).toBe("none");
    });

    it("parses PR number from #N format if URL is absent", async () => {
      const state = createDetectorState();
      recordBash(state, "gh pr create --fill", "Created pull request #22\n");
      const r = await detectPr(state, { cwd: "/tmp" });
      expect(r.prNumber).toBe(22);
      expect(r.source).toBe("gh_pr_create_output");
    });
  });

  describe("Tier 2: branch fallback", () => {
    it("uses gh pr list when last bash was not gh pr create but branch was switched", async () => {
      const state = createDetectorState();
      recordBash(state, "git switch -c feat/foo", "Switched to a new branch 'feat/foo'\n");
      recordBash(state, "pnpm test", "All tests passed\n");
      const ghLister: GhPrLister = vi.fn(async (branch) => {
        expect(branch).toBe("feat/foo");
        return 18;
      });
      const r = await detectPr(state, { cwd: "/tmp", ghPrLister: ghLister });
      expect(ghLister).toHaveBeenCalledOnce();
      expect(r.prNumber).toBe(18);
      expect(r.source).toBe("branch_fallback");
      expect(r.branch).toBe("feat/foo");
    });

    it("returns none if gh pr list finds nothing", async () => {
      const state = createDetectorState();
      recordBash(state, "git checkout -b feat/bar", "Switched to a new branch 'feat/bar'\n");
      const ghLister: GhPrLister = vi.fn(async () => null);
      const r = await detectPr(state, { cwd: "/tmp", ghPrLister: ghLister });
      expect(r.prNumber).toBeNull();
      expect(r.source).toBe("none");
    });

    it("tracks branch from `git switch <existing>` output too", async () => {
      const state = createDetectorState();
      recordBash(state, "git switch main", "Switched to branch 'main'\n");
      recordBash(state, "git switch -c feat/new", "Switched to a new branch 'feat/new'\n");
      const ghLister: GhPrLister = vi.fn(async (branch) => {
        expect(branch).toBe("feat/new"); // most recent switch
        return 5;
      });
      const r = await detectPr(state, { cwd: "/tmp", ghPrLister: ghLister });
      expect(r.prNumber).toBe(5);
    });
  });

  describe("ordering: Tier 1 wins even if Tier 2 would also succeed", () => {
    it("prefers gh pr create output over branch fallback", async () => {
      const state = createDetectorState();
      recordBash(state, "git switch -c feat/z", "Switched to a new branch 'feat/z'\n");
      recordBash(
        state,
        "gh pr create --title 'feat: z'",
        "https://github.com/owner/repo/pull/77\n",
      );
      const ghShouldNotBeCalled: GhPrLister = vi.fn(async () => 999);
      const r = await detectPr(state, { cwd: "/tmp", ghPrLister: ghShouldNotBeCalled });
      expect(r.prNumber).toBe(77);
      expect(r.source).toBe("gh_pr_create_output");
      expect(ghShouldNotBeCalled).not.toHaveBeenCalled();
    });

    it("falls through to branch lookup if gh pr create output is unparseable", async () => {
      const state = createDetectorState();
      recordBash(state, "git switch -c feat/q", "Switched to a new branch 'feat/q'\n");
      recordBash(state, "gh pr create --title 'x'", "weird output that has no URL or hash\n");
      const ghLister: GhPrLister = vi.fn(async (branch) => {
        expect(branch).toBe("feat/q");
        return 42;
      });
      const r = await detectPr(state, { cwd: "/tmp", ghPrLister: ghLister });
      expect(r.prNumber).toBe(42);
      expect(r.source).toBe("branch_fallback");
    });
  });
});
