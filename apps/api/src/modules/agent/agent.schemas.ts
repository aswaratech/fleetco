import { z } from "zod";

// Wire schemas for the agent endpoints (ADR-0043 c4/c5/c7, ticket A5). The
// house conventions apply: `.strict()` everywhere so a typo'd key is a 400,
// field-labeled messages so the web form can surface them inline, and query
// numbers parsed defensively (the trackers.schemas.ts intParam shape).

/**
 * Ceiling on one chat message's length. Generous — a dictated "register this
 * driver…" paragraph fits many times over — but bounded, because the content
 * is Tier-2 stored text AND every character egresses to the hosted provider
 * (ADR-0043 c6c: what the user types reaches the provider verbatim).
 */
export const AGENT_MESSAGE_MAX_LENGTH = 8_000;

const QUERY_MAX_TAKE = 200;

// Coerce a string-typed query param to a bounded integer; out-of-range
// values return 400 rather than being silently clamped. Same helper shape
// as every other list schema (the trackers.schemas.ts precedent).
function intParam(min: number, max: number, fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be an integer.` });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${min} or greater.` });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${max} or less.` });
        return z.NEVER;
      }
      return n;
    });
}

/**
 * POST /api/v1/agent/conversations/:id/turns — one user turn. `content` is
 * the user's chat text (Tier 2 the moment it persists; never logged — pino
 * redacts `*.content`); `attachmentId` (ADR-0044 c7) names one previously
 * uploaded, still-unclaimed attachment to send with this message. At least
 * one of the two is required — a photo may travel with no caption.
 */
export const PostAgentTurnSchema = z
  .object({
    content: z
      .string()
      .trim()
      .max(
        AGENT_MESSAGE_MAX_LENGTH,
        `content must be ${AGENT_MESSAGE_MAX_LENGTH} characters or fewer.`,
      )
      .optional(),
    attachmentId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (data) =>
      (data.content !== undefined && data.content.length > 0) || data.attachmentId !== undefined,
    { message: "content or attachmentId is required." },
  );

export type PostAgentTurnInput = z.infer<typeof PostAgentTurnSchema>;

/**
 * GET /api/v1/agent/conversations query parameters. Pagination only — the
 * conversation rail is a "most recently active first" list (updatedAt desc is
 * fixed, not caller-sortable; it is also the prune basis, so the rail and the
 * retention window agree on what "active" means).
 */
export const ListAgentConversationsQuerySchema = z
  .object({
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  .strict();

export type ListAgentConversationsQuery = z.infer<typeof ListAgentConversationsQuerySchema>;

// Bounded string filter (trim + 64-char cap; empty → undefined) — the
// notification-logs.schemas.ts helper, copied file-locally per the house
// duplication budget. toolName/status are OPEN STRINGS on the model (the
// NotificationLog forward-compat rule): an unknown value returns zero rows,
// never a 400, so a future tool name or status needs no schema edit here.
function stringFilter(fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): string | undefined => {
      if (raw === undefined) return undefined;
      const trimmed = raw.trim();
      if (trimmed.length === 0) return undefined;
      if (trimmed.length > 64) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} is too long.` });
        return z.NEVER;
      }
      return trimmed;
    });
}

// Coerced optional date — the fuel-logs/notification-logs DateFilter shape.
const DateFilter = z.coerce
  .date({ error: () => "Must be a valid date (YYYY-MM-DD or ISO 8601)." })
  .optional();

const ACTION_SORTABLE_COLUMNS = ["createdAt"] as const;
const SORT_DIRECTIONS = ["asc", "desc"] as const;

/**
 * GET /api/v1/agent/actions query parameters (ticket A8 — the activity
 * ledger, DESIGN.md §"Agent activity"). Filters: toolName (exact match),
 * status (succeeded/failed/denied as open strings), and a createdAt date
 * range with the endDate inclusive through end-of-day (the house rule).
 */
export const ListAgentActionsQuerySchema = z
  .object({
    toolName: stringFilter("toolName"),
    status: stringFilter("status"),
    startDate: DateFilter,
    endDate: DateFilter,
    sortBy: z.enum(ACTION_SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  .strict();

export type ListAgentActionsQuery = z.infer<typeof ListAgentActionsQuerySchema>;
export type AgentActionSortColumn = (typeof ACTION_SORTABLE_COLUMNS)[number];
export type AgentActionSortDir = (typeof SORT_DIRECTIONS)[number];
