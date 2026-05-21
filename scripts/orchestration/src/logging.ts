// Logging.
//
// Two streams: append-only decisions.log (summary; every iteration boundary,
// auto-answer, Bash denial, CI result, merge, rate-limit event, termination)
// and per-iter logs/<timestamp>-iter<N>-<slug>.log (full message stream).
//
// Logging is best-effort. A disk-full or permission error must NOT crash the
// loop — log to stderr and continue.

import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.js";
import type { MilestoneEvent } from "./types.js";

let currentIterLogPath: string | null = null;
let currentIterLogStream: fs.WriteStream | null = null;

function ensureLogsDir(): boolean {
  try {
    if (!fs.existsSync(paths.logsDir)) {
      fs.mkdirSync(paths.logsDir, { recursive: true });
    }
    return true;
  } catch (err) {
    process.stderr.write(`[orchestration] logs dir unavailable: ${String(err)}\n`);
    return false;
  }
}

export function appendDecision(event: MilestoneEvent): void {
  try {
    const line = `${new Date().toISOString()} iter=${event.iteration} ${event.milestone}${
      event.pr ? ` pr=${event.pr}` : ""
    }${event.details ? ` :: ${event.details}` : ""}\n`;
    fs.appendFileSync(paths.decisionsLog, line, "utf8");
  } catch (err) {
    process.stderr.write(`[orchestration] decisions.log append failed: ${String(err)}\n`);
  }
}

export function openIterLog(iteration: number, slug: string): void {
  if (!ensureLogsDir()) return;
  try {
    closeIterLog();
    const safe = slug.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 50) || "iter";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    currentIterLogPath = path.join(paths.logsDir, `${ts}-iter${iteration}-${safe}.log`);
    currentIterLogStream = fs.createWriteStream(currentIterLogPath, { flags: "a" });
    currentIterLogStream.on("error", (err) => {
      process.stderr.write(`[orchestration] iter log stream error: ${String(err)}\n`);
    });
    currentIterLogStream.write(`# Iteration ${iteration} log (${new Date().toISOString()})\n\n`);
  } catch (err) {
    process.stderr.write(`[orchestration] failed to open iter log: ${String(err)}\n`);
    currentIterLogPath = null;
    currentIterLogStream = null;
  }
}

export function writeIterLine(line: string): void {
  if (!currentIterLogStream) return;
  try {
    currentIterLogStream.write(line.endsWith("\n") ? line : line + "\n");
  } catch (err) {
    process.stderr.write(`[orchestration] iter log write failed: ${String(err)}\n`);
  }
}

export function closeIterLog(): void {
  if (currentIterLogStream) {
    try {
      currentIterLogStream.end();
    } catch {
      // ignore
    }
    currentIterLogStream = null;
    currentIterLogPath = null;
  }
}

export function getCurrentIterLogPath(): string | null {
  return currentIterLogPath;
}

export function tailDecisions(lines: number): string {
  try {
    if (!fs.existsSync(paths.decisionsLog)) return "(decisions.log not present yet)";
    const content = fs.readFileSync(paths.decisionsLog, "utf8");
    const allLines = content.split("\n").filter((l) => l.length > 0);
    return allLines.slice(-lines).join("\n");
  } catch (err) {
    return `(failed to read decisions.log: ${String(err)})`;
  }
}
