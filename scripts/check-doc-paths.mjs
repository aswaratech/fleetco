#!/usr/bin/env node
/**
 * Docs-consistency check: verifies that the LIVING documents cite repo paths
 * and relative markdown links that still resolve.
 *
 * Scope (deliberate): only living memory is checked. Append-only historical
 * records — ADRs, the CURRENT_PHASE running log, paid-off tech-debt entries,
 * retrospectives, postmortems — describe the repo as it WAS and are excluded;
 * rewriting them to track renames would erase history
 * (see docs/architecture/memory-architecture.md §How the system protects itself).
 *
 * Checks per file:
 *   1. Backticked repo paths (`apps/...`, `docs/...`, `packages/...`,
 *      `scripts/...`, `deploy/...`, `.github/...`) must exist on disk.
 *      Paths containing placeholders (<...>, *, …, {, }) or line refs (:NN)
 *      are checked up to the first such marker's parent that is checkable,
 *      or skipped when nothing checkable remains.
 *   2. Relative markdown links [text](target) must resolve from the file's dir.
 *
 * Exit 1 with a per-file report when anything dangles.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");

/** Living docs only — see scope note above. */
const LIVING_DOCS = [
  "CLAUDE.md",
  "docs/glossary.md",
  "docs/product/roadmap.md",
  "docs/architecture/overview.md",
  "docs/architecture/memory-architecture.md",
  "docs/design/README.md",
  "docs/design/DESIGN.md",
  // tech-debt: only the Active section (paid-off entries are historical archive)
  { path: "docs/tech-debt.md", sliceBefore: "## Paid-off debt" },
];

// Every runbook is living procedure memory by definition.
import { readdirSync } from "node:fs";
for (const f of readdirSync(join(ROOT, "docs/runbook"))) {
  if (f.endsWith(".md")) LIVING_DOCS.push(`docs/runbook/${f}`);
}

const PATH_PREFIXES = [
  "apps/",
  "apps-mobile/",
  "docs/",
  "packages/",
  "scripts/",
  "deploy/",
  ".github/",
];
// Markers meaning "this is a pattern/example, not a literal current path".
const PLACEHOLDER = /[<>*{}…]|\$\{|YYYY|NNNNN|\.\.\./;
// Runtime artifacts that exist by convention on a running/working machine but
// are gitignored, so docs legitimately cite them while a clean checkout lacks
// them. Two rules:
//   (1) any `.env*` file at any depth — the env-template convention (the
//       committed file is `.env.example`; the real `.env` / `.env.test` is
//       created per the runbooks), and
//   (2) the explicit artifact set below (loop control/state files, log dirs).
// IMPORTANT: these must be allowed WITHOUT consulting the local disk — such
// files often exist on a dev machine, and disk-dependent behavior is exactly
// how this check's first version passed locally and failed in CI (the runner's
// clean checkout has no .env files).
const RUNTIME_ENV_FILE = /(^|\/)\.env(\.[\w.-]+)?$/;
const RUNTIME_ALLOW = new Set([
  "deploy/backup.env",
  "scripts/orchestration/.stop",
  "scripts/orchestration/kickoff.md",
  "scripts/orchestration/state.json",
  "scripts/orchestration/logs",
  "scripts/orchestration/logs/",
]);
// `docs/<kebab-name>` with no extension is far more likely a git BRANCH name
// (the house branch convention: docs/memory-repair, docs/invoice-closeout)
// than a directory citation; skip rather than false-positive on provenance notes.
const BRANCH_LIKE = /^docs\/[a-z0-9][a-z0-9-]*$/;

const failures = [];

function checkableExists(p) {
  // Strip trailing punctuation, :line refs, and :SymbolName refs.
  const clean = p
    .replace(/[),.;]+$/, "")
    .replace(/:\d+(-\d+)?$/, "")
    .replace(/:[A-Za-z_$][\w$]*$/, "");
  if (RUNTIME_ALLOW.has(clean) || RUNTIME_ENV_FILE.test(clean) || BRANCH_LIKE.test(clean)) {
    return true;
  }
  if (PLACEHOLDER.test(clean)) {
    // Check the deepest placeholder-free ancestor directory instead.
    const parts = clean.split("/");
    let prefix = [];
    for (const part of parts) {
      if (PLACEHOLDER.test(part)) break;
      prefix.push(part);
    }
    prefix = prefix.join("/");
    // Nothing checkable (placeholder in the first segment) — skip.
    if (!prefix || !PATH_PREFIXES.some((pre) => (prefix + "/").startsWith(pre))) return true;
    return existsSync(join(ROOT, prefix));
  }
  return existsSync(join(ROOT, clean));
}

for (const entry of LIVING_DOCS) {
  const relPath = typeof entry === "string" ? entry : entry.path;
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    failures.push(`${relPath}: file listed in check-doc-paths.mjs does not exist`);
    continue;
  }
  let text = readFileSync(abs, "utf8");
  if (typeof entry !== "string" && entry.sliceBefore) {
    const cut = text.indexOf(entry.sliceBefore);
    if (cut !== -1) text = text.slice(0, cut);
  }
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    // 1. Backticked repo paths.
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const candidate = m[1].trim();
      if (!PATH_PREFIXES.some((pre) => candidate.startsWith(pre))) continue;
      if (/\s/.test(candidate)) continue; // prose inside backticks, not a path
      if (!checkableExists(candidate)) {
        failures.push(`${relPath}:${i + 1}: dangling repo path \`${candidate}\``);
      }
    }
    // 2. Relative markdown links.
    for (const m of line.matchAll(/\]\(([^)#\s]+)(#[^)\s]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:\/\//.test(target) || target.startsWith("mailto:")) continue;
      const resolved = target.startsWith("/")
        ? join(ROOT, target)
        : join(ROOT, dirname(relPath), target);
      if (!existsSync(resolved)) {
        failures.push(`${relPath}:${i + 1}: dangling relative link (${target})`);
      }
    }
  });
}

if (failures.length) {
  console.error(`check-doc-paths: ${failures.length} dangling reference(s) in living docs:\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    "\nFix the reference (or, if the citation is genuinely historical, move it out of the living section).",
  );
  process.exit(1);
}
console.log("check-doc-paths: all living-doc repo paths and relative links resolve.");
