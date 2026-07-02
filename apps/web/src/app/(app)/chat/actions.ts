"use server";

import { apiFetch, ApiError } from "@/lib/api";
import { AGENT_MESSAGE_MAX_LENGTH } from "@/lib/agent-chat";

import type { AgentConversation, AgentTurnResult } from "./types";

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
): Promise<PostTurnResult> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "content is required.", status: 400 };
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
      { method: "POST", json: { content: trimmed } },
    );
    return { ok: true, turn };
  } catch (error) {
    return failureOf(error);
  }
}
