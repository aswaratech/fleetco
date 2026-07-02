import { GPS_SPAN_SCRUB_DENYLIST } from "../../observability/span-scrub";

// The tool-result redaction layer (ADR-0043 commitment 6, ticket A4) — the
// Tier boundary between the database and a foreign-hosted LLM. The registry
// runs `redactForModel` on EVERY tool result before it enters model context
// (the single choke point — a tool cannot forget redaction); A5 reuses it for
// anything else that crosses into a prompt (pre-image summaries, action
// cards' payload echoes).
//
// The c6 contract, PO-ratified line by line:
//   • Tier-5 GPS coordinates and traces  → STRIPPED (key removed entirely).
//     The key set IMPORTS the canonical GPS list from span-scrub.ts — this
//     module is that list's third consumer (logs → spans → model context),
//     honoring the KEEP-IN-SYNC contract structurally instead of by comment.
//   • dateOfBirth                        → STRIPPED.
//   • licenseNumber                      → MASKED to its last 4 chars.
//   • names / phones / emails            → PASS (operational contact data —
//     the agent is useless without them; the PO accepted this explicitly).
//
// One addition beyond the c6 letter: `boundaryWkt` (the Geofence polygon
// text) is STRIPPED. It is Tier-3 (ADR-0030), so c6 does not mandate it — but
// it is raw coordinate data egressing to a PRC-hosted provider, the model has
// no conversational use for a WKT ring, and it wastes prompt tokens. One Set
// entry to flip if boundary geometry ever needs to be conversational.

const toLowerSet = (keys: readonly string[]): ReadonlySet<string> =>
  new Set(keys.map((key) => key.toLowerCase()));

/**
 * Keys whose values never enter model context (matched case-insensitively at
 * every depth). GPS keys come from the one canonical denylist.
 */
export const AGENT_STRIP_KEYS: ReadonlySet<string> = toLowerSet([
  ...GPS_SPAN_SCRUB_DENYLIST,
  "dateOfBirth",
  "boundaryWkt",
]);

/** Keys masked to their last 4 characters (c6: licenseNumber). */
export const AGENT_MASK_KEYS: ReadonlySet<string> = toLowerSet(["licenseNumber"]);

/**
 * Mask a sensitive string to its last 4 characters: `"12-345-6789"` →
 * `"***6789"`. Values of 4 chars or fewer collapse to `"***"` (masking must
 * never reveal the whole value).
 */
export function maskLast4(value: string): string {
  return value.length <= 4 ? "***" : `***${value.slice(-4)}`;
}

/**
 * Recursively redact a tool result for model context. Pure; never mutates the
 * input. Output is guaranteed JSON-serializable (Dates → ISO strings,
 * BigInt → decimal strings — `JSON.stringify` throws on raw BigInt, and
 * Prisma aggregates can emit them), cycle-safe (a revisited object renders as
 * null), and drops functions/symbols. Strip/mask matching is by key,
 * case-insensitive, at EVERY nesting depth — the load-bearing case is
 * `TripDetail.driver`, where the full Driver row (dateOfBirth,
 * licenseNumber) rides nested inside another aggregate's result.
 */
export function redactForModel(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    return value.map((item) => {
      const redacted = redactValue(item, seen);
      // Keep array positions stable for the model (an omitted element would
      // silently shift indexes); non-serializable members render as null.
      return redacted === undefined ? null : redacted;
    });
  }

  if (typeof value === "object") {
    if (seen.has(value)) return null;
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (AGENT_STRIP_KEYS.has(lowerKey)) continue;
      if (AGENT_MASK_KEYS.has(lowerKey)) {
        // Masking is defined on strings only; any other shape fails CLOSED to
        // a strip (never pass an unmasked sensitive value because its type
        // surprised us).
        if (typeof entry === "string") {
          result[key] = maskLast4(entry);
        }
        continue;
      }
      const redacted = redactValue(entry, seen);
      if (redacted !== undefined) {
        result[key] = redacted;
      }
    }
    return result;
  }

  return undefined;
}
