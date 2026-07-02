// Marker-state classification for the /map live-map surface (ADR-0042 M9;
// DESIGN.md §Surfaces "Live map"). Pure functions — all correctness lives
// here and in test/map-markers.test.ts; the map island stays thin (the
// complianceBadgeState pattern).
//
// THE HONESTY RULE: a marker's state derives from the SERVER-computed
// `fixAgeSeconds` (GET /api/v1/telematics/positions/latest), never from the
// client clock — a laptop with a skewed clock must not repaint the fleet.
// The thresholds below were ratified by the DESIGN.md §"Live map" section
// merging (ADR-0042's open pick):
//
//   fresh — age <  2 min  → accent hue: reporting now.
//   aging — age < 15 min  → no special hue (the neutral marker): a normal
//                           between-report gap.
//   stale — age < 24 h    → warning hue: the tracker has gone quiet; the
//                           position is where the vehicle WAS.
//   dead  — age ≥ 24 h    → muted: do not trust this position.

export type MarkerState = "fresh" | "aging" | "stale" | "dead";

export const FRESH_MAX_SECONDS = 2 * 60; // fresh strictly below this
export const AGING_MAX_SECONDS = 15 * 60; // aging strictly below this
export const STALE_MAX_SECONDS = 24 * 60 * 60; // stale strictly below this

/**
 * Classify a server-computed fix age into a marker state. Negative input
 * (a server/device clock disagreement the API already floors at 0 —
 * defensive here) clamps to fresh.
 */
export function markerStateForAge(fixAgeSeconds: number): MarkerState {
  const age = Math.max(0, fixAgeSeconds);
  if (age < FRESH_MAX_SECONDS) return "fresh";
  if (age < AGING_MAX_SECONDS) return "aging";
  if (age < STALE_MAX_SECONDS) return "stale";
  return "dead";
}

/**
 * The fix age in words for popups and sidebar rows ("2 min ago",
 * "3 h ago") — the hue is recognition, this label is the meaning
 * (DESIGN.md anti-pattern #2 applied to markers). Coarse on purpose:
 * an operator needs "how stale", not a stopwatch.
 */
export function fixAgeInWords(fixAgeSeconds: number): string {
  const age = Math.max(0, fixAgeSeconds);
  if (age < 60) return "just now";
  if (age < 60 * 60) return `${Math.floor(age / 60)} min ago`;
  if (age < 24 * 60 * 60) return `${Math.floor(age / (60 * 60))} h ago`;
  const days = Math.floor(age / (24 * 60 * 60));
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
