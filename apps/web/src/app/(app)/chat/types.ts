// Wire shapes for the /chat surface (ADR-0043 A6) — the JSON the A5 agent
// endpoints return, dates as ISO strings the way fetch delivers them. Local
// to the surface per the house pattern (each slice owns its wire types; the
// API's Zod schemas remain the contract's authority).

export interface AgentConversation {
  id: string;
  /** Null until the first turn derives it from the first user message. */
  title: string | null;
  createdAt: string;
  /** Last activity — the rail's ordering key and the prune basis. */
  updatedAt: string;
}

export interface AgentMessage {
  id: string;
  conversationId: string;
  /** "user" | "assistant" | "system" (open string on the wire). */
  role: string;
  /** Empty string on assistant rounds that carried only tool calls. */
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  createdAt: string;
}

export interface AgentAction {
  id: string;
  conversationId: string | null;
  /** The assistant message whose tool_calls produced this dispatch. */
  messageId: string | null;
  toolName: string;
  /** The recorded tool arguments (the operator's own data). */
  argsJson: unknown;
  resultEntityType: string | null;
  resultEntityId: string | null;
  /** "succeeded" | "failed" | "denied" (open string on the wire). */
  status: string;
  latencyMs: number;
  createdAt: string;
}

/** An uploaded chat attachment (ADR-0044 V4/V5). Bytes are fetched only
 * through the authed proxy route — never a public URL (Tier 2). */
export interface AgentAttachment {
  id: string;
  conversationId: string;
  /** Null while pending in the composer; set when a turn claims it. */
  messageId: string | null;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AgentTurnResult {
  conversation: AgentConversation;
  /** Messages persisted by THIS turn (user, assistant rounds, notices). */
  messages: AgentMessage[];
  /** The attachment claimed by this turn's user message, when one was sent. */
  attachments: AgentAttachment[];
  /** Action rows written by THIS turn — the action cards' server source. */
  actions: AgentAction[];
}

export interface AgentTranscript {
  conversation: AgentConversation;
  messages: AgentMessage[];
  /** All the conversation's attachments; joined to messages by messageId. */
  attachments: AgentAttachment[];
  actions: AgentAction[];
}

export interface AgentConversationsListResponse {
  items: AgentConversation[];
  total: number;
  skip: number;
  take: number;
}

/** A rail row: the conversation plus its server-rendered BS date label (the
 * calendar table stays server-side — `<NepaliDate>`'s rule — so the client
 * island receives strings, never the converter). */
export interface ConversationRailRow {
  conversation: AgentConversation;
  lastActivityLabel: string;
}
