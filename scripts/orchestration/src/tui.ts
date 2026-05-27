// Read-only TUI status dashboard for the orchestration loop.
//
// Run: `cd scripts/orchestration && pnpm tui` (or `pnpm exec tsx src/tui.ts`).
// Renders the loop's live state — process liveness, current iteration /
// phase, the milestone timeline, and a tail of the running agent's
// transcript — refreshing every ~2s. Pass `--once` to print a single
// frame and exit (used for non-interactive checks / piping).
//
// This tool is STRICTLY READ-ONLY. It reads the files the loop already
// writes (state.json, decisions.log, logs/<iter>.log) and shells out to
// `pgrep` / `ps` for liveness. It opens no write streams and never
// touches state.json, decisions.log, kickoff.md, .stop, or logs/ — so
// it is safe to run against a live loop without risk of disturbing it.
// Control (stop / resume) is deliberately out of scope; use Slack
// /stop, /resume, or `touch scripts/orchestration/.stop`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { paths } from "./config.js";
import { tailDecisions } from "./logging.js";
import { loadState } from "./state.js";

// ---------- ANSI ----------

const useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;
const c = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string): string => c("2", s);
const bold = (s: string): string => c("1", s);
const green = (s: string): string => c("32", s);
const red = (s: string): string => c("31", s);
const amber = (s: string): string => c("33", s);
const cyan = (s: string): string => c("36", s);

const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// Milestones after which the loop process has exited (terminal states).
const TERMINAL_MILESTONES = new Set(["loop_error", "loop_halted", "program_complete"]);

interface DecisionLine {
  raw: string;
  iso: string;
  iter: number;
  milestone: string;
  pr?: number;
  details?: string;
}

// `<ISO> iter=<N> <milestone>[ pr=<P>][ :: <details>]` — the exact shape
// appendDecision() writes in logging.ts.
const DECISION_RE = /^(\S+) iter=(\d+) (\S+)(?: pr=(\d+))?(?: :: (.*))?$/;

function parseDecision(raw: string): DecisionLine | null {
  const m = DECISION_RE.exec(raw);
  if (!m) return null;
  // Build conditionally: the tsconfig sets exactOptionalPropertyTypes,
  // so an optional `pr?: number` field cannot be explicitly assigned
  // `undefined` — the key is omitted instead when absent.
  return {
    raw,
    iso: m[1] ?? "",
    iter: Number(m[2] ?? "0"),
    milestone: m[3] ?? "",
    ...(m[4] ? { pr: Number(m[4]) } : {}),
    ...(m[5] !== undefined ? { details: m[5] } : {}),
  };
}

function readDecisions(n: number): DecisionLine[] {
  const text = tailDecisions(n);
  if (text.startsWith("(")) return []; // helper's not-present / error sentinel
  return text
    .split("\n")
    .map(parseDecision)
    .filter((d): d is DecisionLine => d !== null);
}

// pgrep for the loop entrypoint. `pnpm start` runs `tsx src/index.ts`,
// but the actual worker process's argv is
//   node … tsx@x.y.z/…/loader.mjs src/index.ts
// — the literal substring "tsx src/index.ts" does NOT appear there, so
// the pattern must allow the loader path between "tsx" and the entry
// file: `tsx.*src/index.ts`. This still excludes this TUI (whose entry
// is `src/tui.ts`, not `src/index.ts`), so it never self-matches.
function findLoopPid(): number | null {
  try {
    const out = execFileSync("pgrep", ["-f", "tsx.*src/index.ts"], { encoding: "utf8" });
    const pid = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0];
    return pid ? Number(pid) : null;
  } catch {
    return null; // pgrep exits non-zero when no match
  }
}

function processUptime(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "etime="], { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
}

// Newest per-iter log file, or null. Read-only readdir + stat.
function newestIterLog(): string | null {
  try {
    const files = fs
      .readdirSync(paths.logsDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const full = path.join(paths.logsDir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.full ?? null;
  } catch {
    return null;
  }
}

// Last `n` meaningful transcript lines from the newest iter log (skips
// the `# Iteration N log` header and blank lines).
function agentTail(logPath: string, n: number): string[] {
  try {
    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0 && !l.startsWith("# Iteration"));
    return lines.slice(-n);
  } catch {
    return [];
  }
}

function ageString(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "?";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${secs % 60}s ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${mins % 60}m ago`;
}

// Human phase label inferred from the most recent milestone.
function phaseLabel(milestone: string, details?: string): string {
  switch (milestone) {
    case "iteration_start":
    case "agent_invocation_start":
      return "agent working";
    case "agent_session_end":
      return "agent session ended — polling CI";
    case "auto_answer":
      return "agent working (auto-answered a question)";
    case "destructive_bash_denied":
      return "agent working (a destructive command was blocked)";
    case "ci_poll_start":
    case "ci_green":
    case "ci_failed":
    case "ci_no_workflows":
    case "ci_timeout":
      return "CI";
    case "pr_opened":
      return "PR opened";
    case "pr_merged":
      return "merged — extracting next prompt";
    case "next_prompt_extracted":
      return "next prompt extracted — starting next iter";
    case "rate_limit_wait": {
      const until = details?.match(/until (\S+)/)?.[1];
      if (until) {
        const ms = new Date(until).getTime() - Date.now();
        const mins = Math.max(0, Math.round(ms / 60000));
        return `rate-limited until ${new Date(until).toISOString().slice(11, 16)} UTC (~${mins}m)`;
      }
      return "rate-limited";
    }
    case "rate_limit_resume":
      return "resumed after rate limit";
    case "next_prompt_missing":
      return "halted — no next prompt";
    case "next_prompt_too_short":
      return "halted — next prompt too short";
    case "no_pr_detected":
      return "halted — no PR produced";
    case "stop_sentinel_detected":
      return "stopped — .stop sentinel";
    case "program_complete":
      return "program complete";
    case "loop_halted":
      return "halted (clean)";
    case "loop_error":
      return "halted (error)";
    default:
      return milestone;
  }
}

function firstKickoffLine(): string {
  try {
    const text = fs.readFileSync(paths.kickoffFile, "utf8");
    const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
    return line.slice(0, 80);
  } catch {
    return "(no kickoff.md)";
  }
}

// ---------- Frame ----------

function render(): string {
  const now = new Date().toISOString().slice(11, 19);
  const width = Math.min(process.stdout.columns ?? 80, 100);
  const rule = dim("─".repeat(width));
  const out: string[] = [];

  out.push(
    `${bold("FleetCo Orchestration Loop")}${" ".repeat(Math.max(1, width - 26 - 11))}${dim(now + " UTC")}`,
  );
  out.push(rule);

  const decisions = readDecisions(40);
  const last = decisions[decisions.length - 1];
  const pid = findLoopPid();
  const state = loadState();

  // Status line.
  if (!last && pid === null) {
    out.push(`${dim("○")} idle — no active run`);
    out.push(`Kickoff  ${dim(firstKickoffLine())}`);
    out.push("");
    out.push(dim(" q quit · r refresh · 2s poll"));
    return out.join("\n");
  }

  const lastAge = last ? ageString(last.iso) : "?";
  const terminal = last ? TERMINAL_MILESTONES.has(last.milestone) : false;

  let statusDot: string;
  let statusWord: string;
  if (pid !== null) {
    statusDot = green("●");
    statusWord = green("RUNNING");
    out.push(
      `${statusDot} ${statusWord}   ${dim("pid")} ${pid}   ${dim("up")} ${processUptime(pid)}      ${dim(`last event ${lastAge}`)}`,
    );
  } else if (terminal) {
    statusDot = red("●");
    statusWord = red("HALTED");
    out.push(`${statusDot} ${statusWord}   ${dim(`(${last?.milestone}) ${lastAge}`)}`);
  } else {
    statusDot = amber("●");
    statusWord = amber("STOPPED?");
    out.push(`${statusDot} ${statusWord}   ${dim(`no process; last event ${lastAge}`)}`);
  }

  // Program / iter / phase.
  const programSlug = decisions.find((d) => d.milestone === "iteration_start")?.details ?? "—";
  out.push(`${dim("Program")}  ${programSlug}`);
  if (last) {
    const attempt =
      decisions
        .filter((d) => d.milestone === "agent_invocation_start" && d.iter === state.iteration)
        .pop()
        ?.details?.replace("attempt=", "") ?? "?";
    const phase = phaseLabel(last.milestone, last.details);
    const phaseColored = terminal
      ? red(phase)
      : last.milestone === "rate_limit_wait"
        ? amber(phase)
        : cyan(phase);
    out.push(
      `${dim("Iter")}     ${state.iteration}   ${dim("attempt")} ${attempt}   ${dim("·")}   ${phaseColored}`,
    );
  }
  out.push(`${dim("Kickoff")}  ${dim(firstKickoffLine())}`);
  if (state.lastPrNumber) {
    out.push(
      `${dim("Last PR")}  #${state.lastPrNumber}${state.lastMergedSha ? dim(` @ ${state.lastMergedSha.slice(0, 7)}`) : ""}`,
    );
  }
  out.push("");

  // Milestone timeline (last 10).
  out.push(bold("Milestones") + dim(" (last 10)"));
  for (const d of decisions.slice(-10)) {
    const t = dim(d.iso.slice(11, 19));
    const iter = dim(`i${d.iter}`);
    const ms = TERMINAL_MILESTONES.has(d.milestone)
      ? red(d.milestone)
      : d.milestone === "pr_merged"
        ? green(d.milestone)
        : d.milestone;
    const extra = [d.pr ? `pr=${d.pr}` : "", d.details ?? ""].filter(Boolean).join("  ");
    out.push(`  ${t}  ${iter}  ${ms}${extra ? "  " + dim(extra) : ""}`);
  }
  out.push("");

  // Agent live tail.
  const logPath = newestIterLog();
  if (logPath) {
    out.push(bold("Agent") + dim(` — live tail (${path.basename(logPath)})`));
    const tail = agentTail(logPath, 6);
    if (tail.length === 0) {
      out.push(dim("  (no transcript yet)"));
    } else {
      for (const line of tail) {
        out.push(dim("  › ") + line.slice(0, width - 4));
      }
    }
    out.push("");
  }

  out.push(dim(" q quit · r refresh now · 2s poll"));
  return out.join("\n");
}

// ---------- Main ----------

function once(): void {
  process.stdout.write(render() + "\n");
}

function interactive(): void {
  let timer: NodeJS.Timeout | null = null;
  const draw = (): void => {
    process.stdout.write(CLEAR + render());
  };

  const cleanup = (): void => {
    if (timer) clearInterval(timer);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(SHOW_CURSOR + "\n");
  };

  process.stdout.write(HIDE_CURSOR);
  draw();
  timer = setInterval(draw, 2000);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "q" || key === "") {
        // q or Ctrl-C
        cleanup();
        process.exit(0);
      }
      if (key === "r") draw();
    });
  }

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

if (process.argv.includes("--once") || process.stdout.isTTY !== true) {
  // Non-interactive: a single frame to stdout. Also the path taken when
  // piped (no TTY), so `pnpm tui | cat` and CI-style checks work.
  once();
} else {
  interactive();
}
