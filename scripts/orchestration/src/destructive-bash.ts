// Destructive-Bash blocklist for the FleetCo orchestration loop.
//
// Principle 7 from docs/runbook/orchestration-loop-design.md: block destructive
// commands at the permission shim. The cost of a false positive is one operator
// interruption; the cost of a false negative can be data loss. Err toward
// over-blocking.
//
// The blocklist is intentionally regex-based on the full command string,
// not on the parsed argv. Agents can construct commands in many ways (env-var
// expansion, subshells, here-docs); a string-level check catches more of them
// than an argv check would.

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
}

export const BLOCKLIST: readonly BlockEntry[] = [
  // ---------- filesystem destroy ----------
  {
    pattern: /\brm\s+([^|;&\n]*\s)?(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive[ \t]+--force|--force[ \t]+--recursive|-rf|-fr)\b/,
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
    reason: "git commit --amend is blocked; the loop relies on additive commits per CLAUDE.md commit discipline",
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
    reason: "prisma db push is forbidden outside local development (CLAUDE.md); use a versioned migration",
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
  },
  // ---------- dependency removals ----------
  {
    pattern: /\b(npm\s+uninstall|pnpm\s+(uninstall|remove)|yarn\s+remove)\b/,
    reason: "dependency removal is operator-only; surfacing as a proposal in the PR description is fine",
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

export function checkBashCommand(command: string): BashCheckResult {
  // Normalize whitespace so patterns can be written linearly; preserve flag tokens.
  const normalized = command.replace(/\s+/g, " ").trim();
  for (const entry of BLOCKLIST) {
    if (entry.pattern.test(normalized)) {
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
