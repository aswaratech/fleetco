"use server";

import { apiFetch, ApiError } from "@/lib/api";
import { AGENT_MESSAGE_MAX_LENGTH } from "@/lib/agent-chat";

import type { AgentAttachment, AgentConversation, AgentTurnResult } from "./types";

// Server actions for the /chat surface (ADR-0043 A6). Both call the A5 agent
// endpoints via apiFetch from the server context (cookies forward
// automatically) and reshape API errors into a structured result the client
// renders inline — the trackers/geofences action pattern. No redirect() on
// success: the chat island owns its state and appends the returned turn
// locally (a full navigation after every message would discard the
// transcript scroll position and re-fetch what the response already carries).
//
// Transport note (ADR-0043 c7): a turn is synchronous request/response — the
// action resolves when the API's loop finishes, bounded by the server's 90 s
// turn wall-clock, which nests inside the web action budget. No streaming in
// v1 (named tech-debt).
//
// Tier-2 note: message content passes through this file on its way to the
// API and is never logged here (no console.*, no analytics).

export interface AgentActionFailure {
  ok: false;
  message: string;
  /** 409 = a turn is already running (the c4d lock); 400 validation; etc. */
  status: number;
}

export type CreateConversationResult =
  | { ok: true; conversation: AgentConversation }
  | AgentActionFailure;

export type PostTurnResult = { ok: true; turn: AgentTurnResult } | AgentActionFailure;

export type UploadAttachmentResult = { ok: true; attachment: AgentAttachment } | AgentActionFailure;

function failureOf(error: unknown): AgentActionFailure {
  if (error instanceof ApiError) {
    return { ok: false, message: error.message, status: error.status };
  }
  // Per Voice: the network line, stated as fact.
  return { ok: false, message: "Cannot reach the server. Retry.", status: 0 };
}

export async function createConversationAction(): Promise<CreateConversationResult> {
  try {
    const conversation = await apiFetch<AgentConversation>("/api/v1/agent/conversations", {
      method: "POST",
    });
    return { ok: true, conversation };
  } catch (error) {
    return failureOf(error);
  }
}

export async function postTurnAction(
  conversationId: string,
  content: string,
  attachmentId?: string,
): Promise<PostTurnResult> {
  const trimmed = content.trim();
  // A photo may travel captionless (ADR-0044 c7) — the content-or-attachment
  // rule the API's schema also enforces.
  if (trimmed.length === 0 && attachmentId === undefined) {
    return { ok: false, message: "content or attachmentId is required.", status: 400 };
  }
  if (trimmed.length > AGENT_MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      message: `content must be ${AGENT_MESSAGE_MAX_LENGTH} characters or fewer.`,
      status: 400,
    };
  }
  try {
    const turn = await apiFetch<AgentTurnResult>(
      `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}/turns`,
      {
        method: "POST",
        json: {
          ...(trimmed.length > 0 ? { content: trimmed } : {}),
          ...(attachmentId !== undefined ? { attachmentId } : {}),
        },
      },
    );
    return { ok: true, turn };
  } catch (error) {
    return failureOf(error);
  }
}

/**
 * Upload one photo against a conversation (ADR-0044 V5). The FormData passes
 * through apiFetch as-is — the multipart boundary survives because apiFetch
 * only sets content-type for its `json` sugar. Server-side, like every write
 * (the browser never talks to the API directly); the 12 MB server-action
 * body limit in next.config.ts covers the 10 MB photo ceiling plus overhead.
 */
export async function uploadAttachmentAction(
  conversationId: string,
  formData: FormData,
): Promise<UploadAttachmentResult> {
  try {
    const attachment = await apiFetch<AgentAttachment>(
      `/api/v1/agent/conversations/${encodeURIComponent(conversationId)}/attachments`,
      { method: "POST", body: formData },
    );
    return { ok: true, attachment };
  } catch (error) {
    return failureOf(error);
  }
}
