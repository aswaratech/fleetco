// Env-var + path configuration for the orchestration loop.
// All env vars are validated up-front via zod; absent required vars fail fast
// with a clear error so the loop never silently starts in a half-configured state.

import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATION_DIR = path.resolve(here, "..");
const DEFAULT_REPO_ROOT = path.resolve(ORCHESTRATION_DIR, "..", "..");

const Schema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  ORCHESTRATION_PRIMARY_MODEL: z.string().default("claude-opus-4-7"),
  ORCHESTRATION_FALLBACK_MODEL: z.string().default("claude-sonnet-4-6"),
  ORCHESTRATION_HAIKU_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_NOTIFY_CHANNEL: z.string().default("#fleetco-loop"),
  ORCHESTRATION_CI_POLL_TIMEOUT_MIN: z.coerce.number().int().positive().default(45),
  ORCHESTRATION_RATE_LIMIT_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  ORCHESTRATION_RATE_LIMIT_BUFFER_SECONDS: z.coerce.number().int().nonnegative().default(60),
  ORCHESTRATION_AGENT_MAX_TURNS: z.coerce.number().int().positive().default(200),
  ORCHESTRATION_REPO_ROOT: z.string().default(DEFAULT_REPO_ROOT),
  DEBUG: z.string().optional(),
});

function loadEnv(): z.infer<typeof Schema> {
  // Best-effort .env loader: read .env if present, parse simple KEY=VALUE pairs.
  // We avoid pulling in dotenv to keep the dep footprint small for this scope.
  try {
    const envPath = path.join(ORCHESTRATION_DIR, ".env");
    // Lazy import fs so this stays trivially testable.
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (!(key in process.env)) process.env[key] = value;
      }
    }
  } catch {
    // .env loading is best-effort. If it fails, real env vars still work.
  }
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment for orchestration loop:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

export const env = loadEnv();

export const paths = {
  orchestrationDir: ORCHESTRATION_DIR,
  repoRoot: path.resolve(env.ORCHESTRATION_REPO_ROOT),
  kickoffFile: path.join(ORCHESTRATION_DIR, "kickoff.md"),
  stateFile: path.join(ORCHESTRATION_DIR, "state.json"),
  decisionsLog: path.join(ORCHESTRATION_DIR, "decisions.log"),
  logsDir: path.join(ORCHESTRATION_DIR, "logs"),
  stopSentinel: path.join(ORCHESTRATION_DIR, ".stop"),
} as const;

export const limits = {
  ciPollTimeoutMs: env.ORCHESTRATION_CI_POLL_TIMEOUT_MIN * 60 * 1000,
  ciPollIntervalMs: 30 * 1000,
  rateLimitMaxRetries: env.ORCHESTRATION_RATE_LIMIT_MAX_RETRIES,
  rateLimitBufferMs: env.ORCHESTRATION_RATE_LIMIT_BUFFER_SECONDS * 1000,
  agentMaxTurns: env.ORCHESTRATION_AGENT_MAX_TURNS,
  // Per-iteration timeout safety net so a stalled session can't run forever.
  iterationHardTimeoutMs: 2 * 60 * 60 * 1000, // 2 hours
} as const;

export const debugMode = env.DEBUG === "1" || env.DEBUG === "true";
