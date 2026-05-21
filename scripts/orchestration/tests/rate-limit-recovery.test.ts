import { describe, it, expect } from "vitest";
import {
  computeWaitFromEvent,
  parseWaitFromException,
  sleepUntil,
} from "../src/rate-limit-recovery.js";

describe("computeWaitFromEvent", () => {
  it("computes resumesAt = resetsAt + buffer (string)", () => {
    const resetsAt = "2026-05-17T12:00:00Z";
    const r = computeWaitFromEvent({ resetsAt }, 60_000);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.toISOString()).toBe("2026-05-17T12:01:00.000Z");
    expect(r!.source).toBe("first_class_event");
  });

  it("computes resumesAt = resetsAt + buffer (Date)", () => {
    const resetsAt = new Date("2026-05-17T12:00:00Z");
    const r = computeWaitFromEvent({ resetsAt }, 30_000);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getTime()).toBe(resetsAt.getTime() + 30_000);
  });

  it("supports snake_case resets_at field", () => {
    const r = computeWaitFromEvent({ resets_at: "2026-05-17T12:00:00Z" }, 60_000);
    expect(r).not.toBeNull();
  });

  it("returns null if no resetsAt is present", () => {
    expect(computeWaitFromEvent({}, 60_000)).toBeNull();
  });

  it("returns null for unparseable resetsAt", () => {
    expect(computeWaitFromEvent({ resetsAt: "not a date" }, 60_000)).toBeNull();
  });
});

describe("parseWaitFromException", () => {
  const noon = new Date("2026-05-17T12:00:00.000Z");

  it("parses 'resets 5:25pm' (interpreted in local TZ relative to now)", () => {
    // Use a "now" of 2026-05-17 10:00 LOCAL time so 5:25pm is in the future today.
    const localNow = new Date(2026, 4, 17, 10, 0, 0); // May = month 4 (zero-indexed)
    const err = new Error("You've hit your limit · resets 5:25pm");
    const r = parseWaitFromException(err, localNow, 0);
    expect(r).not.toBeNull();
    // The wait should land at 17:25 local time on the same day.
    expect(r!.resumesAt.getHours()).toBe(17);
    expect(r!.resumesAt.getMinutes()).toBe(25);
    expect(r!.resumesAt.getDate()).toBe(17);
    expect(r!.source).toBe("thrown_exception");
  });

  it("parses 'resets 5:25am' as 05:25", () => {
    const localNow = new Date(2026, 4, 17, 3, 0, 0);
    const err = new Error("Rate limit hit. Resets 5:25am.");
    const r = parseWaitFromException(err, localNow, 0);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getHours()).toBe(5);
    expect(r!.resumesAt.getMinutes()).toBe(25);
  });

  it("rolls to next day if parsed time is in the past today", () => {
    const localNow = new Date(2026, 4, 17, 18, 0, 0); // 6pm
    const err = new Error("You've hit your limit. Resets 5:25pm."); // 5:25pm today is in the past
    const r = parseWaitFromException(err, localNow, 0);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getDate()).toBe(18); // tomorrow
    expect(r!.resumesAt.getHours()).toBe(17);
    expect(r!.resumesAt.getMinutes()).toBe(25);
  });

  it("parses 24-hour 'resets 17:25'", () => {
    const localNow = new Date(2026, 4, 17, 10, 0, 0);
    const err = new Error("rate limit · resets 17:25 today");
    const r = parseWaitFromException(err, localNow, 0);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getHours()).toBe(17);
    expect(r!.resumesAt.getMinutes()).toBe(25);
  });

  it("parses 'try again in 45 minutes'", () => {
    const r = parseWaitFromException(
      new Error("rate limit hit. Please try again in 45 minutes."),
      noon,
      0,
    );
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getTime() - noon.getTime()).toBe(45 * 60 * 1000);
  });

  it("parses 'retry in 90 seconds'", () => {
    const r = parseWaitFromException(new Error("quota exceeded; retry in 90 seconds"), noon, 0);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getTime() - noon.getTime()).toBe(90 * 1000);
  });

  it("parses 'retry in 2 hours'", () => {
    const r = parseWaitFromException(
      new Error("rate limit hit. Please retry in 2 hours."),
      noon,
      0,
    );
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getTime() - noon.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it("returns null for non-rate-limit errors", () => {
    const r = parseWaitFromException(new Error("ECONNREFUSED 127.0.0.1:443"), noon, 0);
    expect(r).toBeNull();
  });

  it("returns null for rate-limit-ish messages without a parseable time", () => {
    const r = parseWaitFromException(new Error("rate limit hit, please slow down"), noon, 0);
    expect(r).toBeNull();
  });

  it("adds buffer to the parsed time", () => {
    const localNow = new Date(2026, 4, 17, 10, 0, 0);
    const err = new Error("Rate limit. Resets 11:00am.");
    const r = parseWaitFromException(err, localNow, 60_000);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getMinutes()).toBe(1); // 11:00 + 60s
    expect(r!.resumesAt.getHours()).toBe(11);
  });

  // Field-observed phrasing (iter 1 of Phase 1 Vehicles slice, 2026-05-21):
  // the SDK's subprocess exited with a generic "Claude Code process exited
  // with code 1" error, but the agent's final streamed message contained
  // the rate-limit signal. index.ts's catch block falls back to parsing
  // the transcript tail directly when the exception itself has no signal.
  // This test asserts the parser accepts a raw string and matches the
  // field-observed phrasing.
  it("parses raw string with field-observed phrasing 'You've hit your limit · resets H:MMam (TZ)'", () => {
    const localNow = new Date(2026, 4, 21, 23, 50, 0); // 11:50pm local
    const transcriptTail = "You've hit your limit · resets 3:15am (Asia/Katmandu)";
    const r = parseWaitFromException(transcriptTail, localNow, 0);
    expect(r).not.toBeNull();
    expect(r!.resumesAt.getHours()).toBe(3);
    expect(r!.resumesAt.getMinutes()).toBe(15);
    // 11:50pm + ~3.5h → next day 3:15am
    expect(r!.resumesAt.getDate()).toBe(22);
    expect(r!.source).toBe("thrown_exception");
  });
});

describe("sleepUntil", () => {
  it("returns immediately if target is in the past", async () => {
    const start = Date.now();
    await sleepUntil(new Date(Date.now() - 1000), { tickMs: 100 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("sleeps the right duration for a near-future target", async () => {
    const start = Date.now();
    const target = new Date(Date.now() + 150);
    await sleepUntil(target, { tickMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(400); // some scheduler jitter tolerance
  });

  it("fires onTick callback during sleep", async () => {
    const ticks: number[] = [];
    const target = new Date(Date.now() + 250);
    await sleepUntil(target, {
      tickMs: 80,
      onTick: (remaining) => ticks.push(remaining),
    });
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });
});
