import { describe, expect, test } from "vitest";

import {
  AGING_MAX_SECONDS,
  FRESH_MAX_SECONDS,
  STALE_MAX_SECONDS,
  fixAgeInWords,
  markerStateForAge,
} from "../src/lib/map-markers";

// Boundary tests for the /map marker-state classifier (ADR-0042 M9),
// mirroring compliance.test.ts: the pure helper carries all correctness;
// the map island is markup + polling and ships untested-by-render (no
// jsdom harness — vitest collects only test/**/*.test.ts, node env).
//
// The thresholds are the DESIGN.md §"Live map" contract: <2 min fresh,
// <15 min aging, <24 h stale, ≥24 h dead — each boundary is exclusive on
// the younger side (exactly 120 s is aging, not fresh).

describe("markerStateForAge — the ratified thresholds, boundary-exact", () => {
  test("the named constants are the spec's numbers", () => {
    expect(FRESH_MAX_SECONDS).toBe(120);
    expect(AGING_MAX_SECONDS).toBe(900);
    expect(STALE_MAX_SECONDS).toBe(86_400);
  });

  test("fresh: 0 and 119 s", () => {
    expect(markerStateForAge(0)).toBe("fresh");
    expect(markerStateForAge(119)).toBe("fresh");
  });

  test("aging: exactly 120 s through 899 s", () => {
    expect(markerStateForAge(120)).toBe("aging");
    expect(markerStateForAge(899)).toBe("aging");
  });

  test("stale: exactly 900 s through 86399 s", () => {
    expect(markerStateForAge(900)).toBe("stale");
    expect(markerStateForAge(86_399)).toBe("stale");
  });

  test("dead: exactly 86400 s and beyond", () => {
    expect(markerStateForAge(86_400)).toBe("dead");
    expect(markerStateForAge(30 * 86_400)).toBe("dead");
  });

  test("a negative age (defensive — the API floors at 0) clamps to fresh", () => {
    expect(markerStateForAge(-5)).toBe("fresh");
  });
});

describe("fixAgeInWords — coarse, human, never a stopwatch", () => {
  test("under a minute reads as just now", () => {
    expect(fixAgeInWords(0)).toBe("just now");
    expect(fixAgeInWords(59)).toBe("just now");
  });

  test("minutes from 60 s (floored)", () => {
    expect(fixAgeInWords(60)).toBe("1 min ago");
    expect(fixAgeInWords(119)).toBe("1 min ago");
    expect(fixAgeInWords(120)).toBe("2 min ago");
    expect(fixAgeInWords(3_599)).toBe("59 min ago");
  });

  test("hours from 3600 s (floored)", () => {
    expect(fixAgeInWords(3_600)).toBe("1 h ago");
    expect(fixAgeInWords(3 * 3_600 + 1_200)).toBe("3 h ago");
    expect(fixAgeInWords(86_399)).toBe("23 h ago");
  });

  test("days from 86400 s, singular/plural", () => {
    expect(fixAgeInWords(86_400)).toBe("1 day ago");
    expect(fixAgeInWords(3 * 86_400)).toBe("3 days ago");
  });

  test("negative clamps like the classifier", () => {
    expect(fixAgeInWords(-5)).toBe("just now");
  });
});
