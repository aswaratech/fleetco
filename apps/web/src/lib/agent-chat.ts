// Pure helpers for the /chat surface (ADR-0043 A6, DESIGN.md §"Agent chat").
// Kept out of the client island so they unit-test headlessly, the
// markerStateForAge precedent.

/**
 * Mirror of the API's PostAgentTurnSchema bound (agent.schemas.ts). Lives
 * here (not in the "use server" actions file, which may only export async
 * functions) so the composer's maxLength and the action's guard share it.
 */
export const AGENT_MESSAGE_MAX_LENGTH = 8_000;

/** One piece of assistant text after linkification. */
export type LinkifiedSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

// The app routes assistant text may link to — the nav destinations plus
// their detail sub-paths. DESIGN.md §"Agent chat": model text is UNTRUSTED
// input, so linkification is allowlist-only; arbitrary URLs/schemes never
// become clickable (the prompt-injection posture applied to rendering).
const LINKABLE_ROUTE_PREFIXES: readonly string[] = [
  "/vehicles",
  "/drivers",
  "/customers",
  "/jobs",
  "/trips",
  "/fuel-logs",
  "/expense-logs",
  "/geofences",
  "/trackers",
  "/invoices",
  "/service-schedules",
  "/service-records",
  "/notification-logs",
  "/map",
  "/reports/per-vehicle-cost",
  "/reports/per-vehicle-efficiency",
];

// A candidate path: "/" followed by route-ish characters. Candidates are then
// VALIDATED against the allowlist — the regex only finds, never authorizes.
const PATH_CANDIDATE = /\/[A-Za-z0-9/_-]+/g;

function isAllowlistedPath(path: string): boolean {
  return LINKABLE_ROUTE_PREFIXES.some(
    (prefix) =>
      path === prefix ||
      // One id segment below a prefix ("/vehicles/cm9xyz…"); deeper nesting
      // is not a linkable detail page today.
      (path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes("/")),
  );
}

/**
 * Split assistant text into text/link segments. Only allowlisted app routes
 * (optionally with one trailing id segment) become links; everything else —
 * external URLs, unknown paths, schemes — stays inert text. Trailing sentence
 * punctuation is excluded from the match ("see /vehicles/abc." links
 * "/vehicles/abc", keeps the period as text).
 */
export function linkifyAppPaths(text: string): LinkifiedSegment[] {
  const segments: LinkifiedSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(PATH_CANDIDATE)) {
    const raw = match[0];
    const start = match.index;
    // Trim trailing chars that are valid in the regex's charset but are far
    // more likely sentence punctuation than an id ("-" and "_" stay: real
    // cuids never end the sentence in model prose without punctuation).
    const path = raw.replace(/\/+$/, "");
    if (!isAllowlistedPath(path)) continue;
    // Do not linkify the middle of a larger token (e.g. "https://x.com/map").
    const before = text[start - 1];
    if (before !== undefined && !/[\s([{'"`]/.test(before)) continue;

    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    segments.push({ kind: "link", text: path, href: path });
    cursor = start + path.length;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/**
 * The Badge variant for an AgentAction status (DESIGN.md §"Agent chat"):
 * succeeded → success, failed → error, denied (and anything unexpected) →
 * neutral. Fail-closed to neutral: an unknown status must not render as
 * success.
 */
export function actionBadgeVariant(status: string): "success" | "error" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  return "neutral";
}

/** "320 ms" below a second; "1.4 s" at and above (tabular-nums renders it). */
export function formatLatencyMs(latencyMs: number): string {
  if (latencyMs < 1000) return `${latencyMs} ms`;
  return `${(latencyMs / 1000).toFixed(1)} s`;
}
