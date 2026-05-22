// Destructive-Bash blocklist for the FleetCo orchestration loop.
//
// Principle 7 from docs/runbook/orchestration-loop-design.md: block destructive
// commands at the permission shim. The cost of a false positive is one operator
// interruption; the cost of a false negative can be data loss. Err toward
// over-blocking.
//
// The blocklist is regex-based. By default, patterns are applied to a
// "stripped" version of the command where double-quoted strings, single-quoted
// strings, and heredoc bodies have been replaced with whitespace. This means
// `gh pr create --body "..."` won't false-positive just because the PR body
// happens to contain the literal text `prisma migrate reset` as documentation.
// Surfaced by iter 1 of the Phase 1 Vehicles slice (2026-05-22): the agent
// burned an attempt re-running `gh pr create` with a shorter body after the
// first attempt was denied for "prisma migrate reset" text inside the body.
//
// A small number of patterns DO need to inspect the original command including
// quoted content — specifically `psql -c "<destructive SQL>"`, where the entire
// point is that the destructive SQL lives inside a quoted argument. Those
// patterns set `inspectQuoted: true`.

export interface BlockEntry {
  pattern: RegExp;
  reason: string;
  // For documentation / logging only — what kind of damage this prevents.
  category:
    | "filesystem_destroy"
    | "git_history_rewrite"
    | "git_force_push"
    | "git_reset_or_amend"
    | "github_pr_lifecycle"
    | "database_destroy"
    | "dependency_remove"
    | "system_path_write"
    | "process_kill"
    | "container_destroy";
  // If true, the pattern is applied to the ORIGINAL command string (including
  // quoted/heredoc content). Default false: pattern is applied to a stripped
  // version where quoted content has been removed. Set to true only for
  // patterns whose intent is to catch destructive content INSIDE quoted args
  // (the canonical case: `psql -c "<destructive SQL>"`).
  inspectQuoted?: boolean;
}

export const BLOCKLIST: readonly BlockEntry[] = [
  // ---------- filesystem destroy ----------
  {
    pattern:
      /\brm\s+([^|;&\n]*\s)?(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive[ \t]+--force|--force[ \t]+--recursive|-rf|-fr)\b/,
    reason: "rm with recursive+force is blocked; remove paths individually or with care",
    category: "filesystem_destroy",
  },
  // ---------- git force-push ----------
  {
    pattern: /\bgit\s+push\b[^|;&\n]*\s(--force|--force-with-lease|-f)\b/,
    reason: "git push with --force is blocked; merge or rebase locally and push normally",
    category: "git_force_push",
  },
  // ---------- git reset --hard ----------
  {
    pattern: /\bgit\s+reset\b[^|;&\n]*\s--hard\b/,
    reason: "git reset --hard discards uncommitted work; checkout files individually",
    category: "git_reset_or_amend",
  },
  // ---------- git commit --amend (loop wants additive iteration) ----------
  {
    pattern: /\bgit\s+commit\b[^|;&\n]*\s--amend\b/,
    reason:
      "git commit --amend is blocked; the loop relies on additive commits per CLAUDE.md commit discipline",
    category: "git_reset_or_amend",
  },
  // ---------- git rebase -i / --interactive ----------
  {
    pattern: /\bgit\s+rebase\b[^|;&\n]*\s(--interactive|-i)\b/,
    reason: "interactive rebase rewrites history and cannot run unattended",
    category: "git_history_rewrite",
  },
  // ---------- git history rewrite ----------
  {
    pattern: /\bgit\s+(filter-branch|filter-repo)\b/,
    reason: "git filter-branch / filter-repo rewrites history globally; blocked unattended",
    category: "git_history_rewrite",
  },
  {
    pattern: /\bgit\s+update-ref\s+-d\s+refs\/heads\//,
    reason: "deleting a branch ref via update-ref is destructive; use git branch -d",
    category: "git_history_rewrite",
  },
  // ---------- gh pr lifecycle (loop owns merge, not agent) ----------
  {
    pattern: /\bgh\s+pr\s+close\b/,
    reason: "the loop, not the agent, decides PR lifecycle; do not close PRs",
    category: "github_pr_lifecycle",
  },
  {
    pattern: /\bgh\s+pr\s+merge\b/,
    reason: "the loop, not the agent, performs the merge after CI is green",
    category: "github_pr_lifecycle",
  },
  // ---------- database destroy (forbidden per CLAUDE.md) ----------
  {
    pattern: /\b(pnpm|npm|yarn|npx)?\s*prisma\s+db\s+push\b/,
    reason:
      "prisma db push is forbidden outside local development (CLAUDE.md); use a versioned migration",
    category: "database_destroy",
  },
  {
    pattern: /\b(pnpm|npm|yarn|npx)?\s*prisma\s+migrate\s+(reset|deploy)\b/,
    reason: "prisma migrate reset/deploy can drop or apply against prod; operator runs these",
    category: "database_destroy",
  },
  {
    pattern: /\bpsql\b[^|;&\n]*\s-c\s+["'][^"']*\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i,
    reason: "hand-editing the database via psql is forbidden (CLAUDE.md)",
    category: "database_destroy",
    // This pattern's whole point is to catch destructive SQL inside the -c
    // quoted argument; we must NOT strip quotes before matching.
    inspectQuoted: true,
  },
  // ---------- dependency removals ----------
  {
    pattern: /\b(npm\s+uninstall|pnpm\s+(uninstall|remove)|yarn\s+remove)\b/,
    reason:
      "dependency removal is operator-only; surfacing as a proposal in the PR description is fine",
    category: "dependency_remove",
  },
  {
    pattern: /\b(pnpm|npm|yarn)\s+install\b[^|;&\n]*\s--force\b/,
    reason: "package install --force can bypass lockfile integrity; operator decides",
    category: "dependency_remove",
  },
  // ---------- container/volume destroy (loses local state) ----------
  {
    pattern: /\bdocker\s+system\s+prune\b/,
    reason: "docker system prune destroys local images/containers/volumes; operator runs this",
    category: "container_destroy",
  },
  {
    pattern: /\bdocker\s+volume\s+rm\b/,
    reason: "docker volume rm destroys local data; operator runs this",
    category: "container_destroy",
  },
  {
    pattern: /\bdocker\s+compose\s+down\b[^|;&\n]*\s-v\b/,
    reason: "docker compose down -v removes named volumes; operator runs this",
    category: "container_destroy",
  },
  // ---------- process kill ----------
  {
    pattern: /\b(pkill|killall)\b/,
    reason: "broad process kill is blocked; target a specific PID with kill",
    category: "process_kill",
  },
  {
    pattern: /\bkill\s+-9\s+1\b/,
    reason: "killing PID 1 is blocked",
    category: "process_kill",
  },
  // ---------- system path writes (defense in depth on darwin/linux) ----------
  {
    pattern: /[>|]\s*\/etc\//,
    reason: "writing to /etc/ is blocked",
    category: "system_path_write",
  },
  {
    pattern: /[>|]\s*\/usr\//,
    reason: "writing to /usr/ is blocked",
    category: "system_path_write",
  },
  {
    pattern: /[>|]\s*\/System\//,
    reason: "writing to /System/ is blocked",
    category: "system_path_write",
  },
  {
    pattern: /[>|]\s*\/Library\/(?!Caches\/)/,
    reason: "writing to /Library/ (outside /Library/Caches/) is blocked",
    category: "system_path_write",
  },
];

export interface BashCheckResult {
  allowed: boolean;
  reason?: string;
  matchedPattern?: string;
  category?: BlockEntry["category"];
}

/**
 * Strip quoted strings and heredoc bodies from a shell command so the resulting
 * string represents only the command/argument structure, not user-supplied
 * literal text. Used so patterns like `prisma migrate reset` don't false-positive
 * on `gh pr create --body "...prisma migrate reset..."`.
 */
function stripQuotedAndHeredocs(cmd: string): string {
  let result = cmd;
  // Heredocs first: <<EOF ... \nEOF or <<'EOF' ... \nEOF (tag is usually EOF).
  // Multi-line aware: the body can contain anything until a line with just the tag.
  result = result.replace(/<<\s*['"]?(\w+)['"]?\s*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, " ");
  // Double-quoted strings (with escaped-quote support).
  result = result.replace(/"(?:\\.|[^"\\])*"/g, " ");
  // Single-quoted strings (POSIX: no escapes inside).
  result = result.replace(/'[^']*'/g, " ");
  return result;
}

export function checkBashCommand(command: string): BashCheckResult {
  // Normalize whitespace so patterns can be written linearly; preserve flag tokens.
  const normalized = command.replace(/\s+/g, " ").trim();
  const stripped = stripQuotedAndHeredocs(normalized).replace(/\s+/g, " ").trim();
  for (const entry of BLOCKLIST) {
    const target = entry.inspectQuoted ? normalized : stripped;
    if (entry.pattern.test(target)) {
      return {
        allowed: false,
        reason: entry.reason,
        matchedPattern: entry.pattern.source,
        category: entry.category,
      };
    }
  }
  return { allowed: true };
}
