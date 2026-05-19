// Auto-merge after CI green.
//
// The loop, not the agent, performs the merge. This is principle 4's symmetry:
// the agent must NOT call `gh pr merge` (which the destructive-bash blocklist
// already enforces), and the loop is the single authority over PR lifecycle.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { paths } from "./config.js";

const execFileAsync = promisify(execFile);

export interface MergeResult {
  ok: boolean;
  mergedSha?: string;
  error?: string;
}

export async function autoMerge(prNumber: number): Promise<MergeResult> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "merge", String(prNumber), "--merge", "--delete-branch"],
      { cwd: paths.repoRoot, timeout: 60_000 },
    );
    // gh prints merge confirmation; we look for the SHA if present.
    const m = stdout.match(/([0-9a-f]{7,40})/);
    return { ok: true, ...(m?.[1] ? { mergedSha: m[1] } : {}) };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: e.stderr ?? e.message ?? String(err) };
  }
}
