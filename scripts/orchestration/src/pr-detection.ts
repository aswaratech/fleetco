// PR detection.
//
// Principle 4 from docs/runbook/orchestration-loop-design.md: detect PR
// numbers only after the agent actually creates one. The agent routinely
// mentions prior PRs by number in narrative text, which would produce false
// triggers if we grepped narrative.
//
// Strategy:
//   1. Track which Bash command was last fired. If it was `gh pr create`,
//      parse the PR number from THAT specific command's output.
//   2. Fallback: track the latest branch name from "Switched to a new branch
//      'X'" output. After the session ends, call `gh pr list --head X` to
//      look up a PR matching the branch.
//   3. Otherwise return none.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PrDetectionResult } from "./types.js";

const execFileAsync = promisify(execFile);

const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const PR_URL_RE = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/;
// Some gh versions print "Created pull request #N" or "pull request #N was created".
const PR_HASH_RE = /(?:created\s+pull\s+request|pull\s+request)\s+#(\d+)/i;
// git switch -c / checkout -b output
const SWITCHED_NEW_BRANCH_RE = /Switched to a new branch ['"]([^'"]+)['"]/;
const SWITCHED_BRANCH_RE = /Switched to branch ['"]([^'"]+)['"]/;

export interface PrDetectorState {
  lastBashCommand: string | null;
  lastBashOutput: string | null;
  lastSwitchedBranch: string | null;
}

export function createDetectorState(): PrDetectorState {
  return {
    lastBashCommand: null,
    lastBashOutput: null,
    lastSwitchedBranch: null,
  };
}

export function recordBash(state: PrDetectorState, command: string, output: string): void {
  state.lastBashCommand = command;
  state.lastBashOutput = output;
  // Always scan the output for a branch switch, since switching can happen in
  // any Bash command (e.g., `git switch -c feat/x && touch README.md`).
  const newBranch = SWITCHED_NEW_BRANCH_RE.exec(output);
  if (newBranch?.[1]) {
    state.lastSwitchedBranch = newBranch[1];
    return;
  }
  const existingBranch = SWITCHED_BRANCH_RE.exec(output);
  if (existingBranch?.[1]) {
    state.lastSwitchedBranch = existingBranch[1];
  }
}

export interface GhPrLister {
  (branch: string, cwd: string): Promise<number | null>;
}

export const defaultGhPrLister: GhPrLister = async (branch, cwd) => {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "1"],
      { cwd, timeout: 20_000 },
    );
    const parsed = JSON.parse(stdout) as Array<{ number: number }>;
    return parsed[0]?.number ?? null;
  } catch {
    return null;
  }
};

export interface DetectOptions {
  cwd: string;
  ghPrLister?: GhPrLister;
}

export async function detectPr(
  state: PrDetectorState,
  options: DetectOptions,
): Promise<PrDetectionResult> {
  // Tier 1: last Bash was `gh pr create` — parse its specific output.
  if (state.lastBashCommand && state.lastBashOutput && GH_PR_CREATE_RE.test(state.lastBashCommand)) {
    const urlMatch = PR_URL_RE.exec(state.lastBashOutput);
    if (urlMatch?.[1]) {
      return { prNumber: Number(urlMatch[1]), source: "gh_pr_create_output" };
    }
    const hashMatch = PR_HASH_RE.exec(state.lastBashOutput);
    if (hashMatch?.[1]) {
      return { prNumber: Number(hashMatch[1]), source: "gh_pr_create_output" };
    }
    // gh pr create ran but we couldn't parse — fall through to branch fallback.
  }

  // Tier 2: branch-name fallback via `gh pr list --head <branch>`.
  if (state.lastSwitchedBranch) {
    const lister = options.ghPrLister ?? defaultGhPrLister;
    const prNumber = await lister(state.lastSwitchedBranch, options.cwd);
    if (prNumber !== null) {
      return { prNumber, source: "branch_fallback", branch: state.lastSwitchedBranch };
    }
  }

  return { prNumber: null, source: "none" };
}
