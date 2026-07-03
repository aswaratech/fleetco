// Wire shapes for the /agent/activity surface (ADR-0043 A8) — the JSON
// GET /api/v1/agent/actions returns. Local to the surface per the house
// pattern (each slice owns its wire types).

export interface AgentActionListItem {
  id: string;
  /** Null once the 180-day transcript prune detaches the conversation. */
  conversationId: string | null;
  messageId: string | null;
  toolName: string;
  /** The recorded tool arguments (Tier 2 — rendered for the ADMIN only). */
  argsJson: unknown;
  resultEntityType: string | null;
  resultEntityId: string | null;
  /** The update pre-image (Tier 2); null for reads, creates, and failures. */
  previousJson: unknown;
  /** "succeeded" | "failed" | "denied" (open string on the wire). */
  status: string;
  latencyMs: number;
  createdAt: string;
  /** The acting human (ADR-0043 c1 — attribution is the user, not a bot). */
  user: { id: string; email: string; name: string | null };
}

export interface AgentActionsListResponse {
  items: AgentActionListItem[];
  total: number;
  skip: number;
  take: number;
  sortBy: "createdAt";
  sortDir: "asc" | "desc";
}
