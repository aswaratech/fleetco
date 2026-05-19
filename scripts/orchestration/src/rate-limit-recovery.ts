// Rate-limit recovery.
//
// Principle 6 from docs/runbook/orchestration-loop-design.md: plan for rate
// limits. Two flavors observed in the field run:
//   1. First-class event: SDK emits `rate_limit_event` with status: 'rejected'
//      and a `resetsAt` timestamp; sleep until resetsAt + buffer and re-fire.
//   2. Thrown exception: mid-session a cap throws with human-language message
//      "You've hit your limit · resets 5:25pm"; parse the time, sleep, re-fire.
//
// Cap at N retries per iteration (default 3); halt on the (N+1)th. Notify on
// every wait and resume so the operator knows the loop is sleeping rather
// than dead.

import { limits } from "./config.js";
import type { RateLimitWaitInfo } from "./types.js";

// ---------- First-class event ----------

export function computeWaitFromEvent(
  event: { resetsAt?: string | Date | number; resets_at?: string | Date | number },
  bufferMs: number = limits.rateLimitBufferMs,
): RateLimitWaitInfo | null {
  const ra = event.resetsAt ?? event.resets_at;
  if (ra === undefined) return null;
  const resetsAt = ra instanceof Date ? ra : new Date(ra);
  if (Number.isNaN(resetsAt.getTime())) return null;
  return {
    resumesAt: new Date(resetsAt.getTime() + bufferMs),
    reason: "rate_limit_event from SDK",
    source: "first_class_event",
  };
}

// ---------- Thrown exception ----------

// We support several phrasings seen in the wild. Each capture group yields
// hour/minute/am-pm or 24-hour time, optionally with a timezone offset.
const EXCEPTION_PATTERNS: ReadonlyArray<RegExp> = [
  // "resets 5:25pm" / "resets at 5:25 PM" (case-insensitive)
  /(?:resets|reset|reset at|resets at)\s+(\d{1,2}):(\d{2})\s*(am|pm)/i,
  // "limit will reset at 5:25pm"
  /limit\s+will\s+reset\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)/i,
  // "resets 17:25" (24-hour)
  /(?:resets|reset|reset at|resets at)\s+(\d{1,2}):(\d{2})(?:[^0-9]|$)/i,
  // "try again in 45 minutes" / "retry in 90 seconds"
  /try\s+again\s+in\s+(\d+)\s+(minute|minutes|hour|hours|second|seconds|min|mins|hr|hrs|sec|secs)/i,
  /retry\s+in\s+(\d+)\s+(minute|minutes|hour|hours|second|seconds|min|mins|hr|hrs|sec|secs)/i,
];

function applyTimeOfDay(now: Date, hour: number, minute: number): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  // If the resulting time is in the past (or equal to now), it must mean tomorrow.
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function applyRelativeDuration(now: Date, amount: number, unit: string): Date {
  const u = unit.toLowerCase();
  let ms = 0;
  if (u.startsWith("sec")) ms = amount * 1000;
  else if (u.startsWith("min")) ms = amount * 60 * 1000;
  else if (u.startsWith("hr") || u.startsWith("hour")) ms = amount * 60 * 60 * 1000;
  return new Date(now.getTime() + ms);
}

export function parseWaitFromException(
  err: unknown,
  now: Date = new Date(),
  bufferMs: number = limits.rateLimitBufferMs,
): RateLimitWaitInfo | null {
  const msg = errorMessage(err);
  if (!msg) return null;
  // Heuristic: only count this as a rate-limit exception if the message
  // mentions limit/quota/rate (so we don't spuriously parse unrelated errors).
  if (!/limit|quota|rate[- ]?limit|too many requests/i.test(msg)) return null;

  for (const re of EXCEPTION_PATTERNS) {
    const m = re.exec(msg);
    if (!m) continue;
    // Relative-duration patterns (capture group 2 is a time unit word).
    if (m[2] && /(min|sec|hour|hr)/i.test(m[2])) {
      const resumesAt = new Date(applyRelativeDuration(now, Number(m[1]), m[2]).getTime() + bufferMs);
      return {
        resumesAt,
        reason: `Parsed from exception: try again in ${m[1]} ${m[2]}`,
        source: "thrown_exception",
      };
    }
    // Time-of-day patterns.
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    const ampm = m[3];
    if (ampm) {
      const isPm = /pm/i.test(ampm);
      if (hour === 12) hour = isPm ? 12 : 0;
      else if (isPm) hour += 12;
    }
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
    const target = applyTimeOfDay(now, hour, minute);
    const resumesAt = new Date(target.getTime() + bufferMs);
    return {
      resumesAt,
      reason: `Parsed from exception: resets ${m[1]}:${String(minute).padStart(2, "0")}${ampm ?? ""}`,
      source: "thrown_exception",
    };
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(err);
}

// ---------- Sleep helper ----------

/**
 * Sleep until the given absolute time. `onTick` is invoked with the remaining
 * ms after each tick (default 1 minute), useful for periodic notifications
 * during long waits. Returns when now >= target.
 */
export async function sleepUntil(
  target: Date,
  options: { tickMs?: number; onTick?: (remainingMs: number) => void } = {},
): Promise<void> {
  const tickMs = options.tickMs ?? 60_000;
  while (true) {
    const remaining = target.getTime() - Date.now();
    if (remaining <= 0) return;
    const wait = Math.min(remaining, tickMs);
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
    if (options.onTick) options.onTick(Math.max(0, target.getTime() - Date.now()));
  }
}
