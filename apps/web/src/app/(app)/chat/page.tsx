import { redirect } from "next/navigation";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { apiFetch, ApiError } from "@/lib/api";
import { formatNepaliDate } from "@/lib/nepali-date";

import { ChatClient } from "./chat-client";
import type { AgentConversationsListResponse, AgentTranscript, ConversationRailRow } from "./types";

// Agent chat — ADR-0043 A6, built exactly to DESIGN.md §Surfaces "Agent
// chat": the conversational surface where the operator talks to the AI
// agent. Server component: gates the session, fetches the conversation rail
// and (when `?c=` selects one) the stored transcript, then hands everything
// to the client island that owns the composer and appends turns locally.
//
// This is the app's FIRST ADMIN-only surface (`agent:use`, ADR-0043 c1). The
// API is the security boundary; a non-ADMIN who navigates here directly gets
// its 403, rendered as the plain fact line below — no redirect, no apology.
//
// Selection rides the URL as `?c=<conversation-id>` (an id is Tier 4);
// message CONTENT never enters a URL (anti-pattern #15 applied to
// transcripts).

interface ChatPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ChatPage({
  searchParams,
}: ChatPageProps): Promise<React.ReactElement> {
  const params = await searchParams;
  const selectedId = typeof params.c === "string" && params.c !== "" ? params.c : null;

  let conversations: AgentConversationsListResponse;
  try {
    conversations = await apiFetch<AgentConversationsListResponse>("/api/v1/agent/conversations");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    if (error instanceof ApiError && error.status === 403) {
      // DESIGN.md §"Agent chat": the fact, stated plainly.
      return (
        <ChatShell>
          <p className="text-text-muted text-sm">The agent is available to the ADMIN role only.</p>
        </ChatShell>
      );
    }
    throw error;
  }

  // A stale/foreign `?c=` (deleted by the 180-day prune, mistyped, another
  // user's) 404s — degrade to "nothing selected" with the rail intact rather
  // than a hard not-found page: the rail IS the recovery affordance.
  let transcript: AgentTranscript | null = null;
  if (selectedId !== null) {
    try {
      transcript = await apiFetch<AgentTranscript>(
        `/api/v1/agent/conversations/${encodeURIComponent(selectedId)}`,
      );
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        throw error;
      }
    }
  }

  // BS date labels render server-side so the calendar table never enters the
  // client bundle (the <NepaliDate> rule; the island receives strings).
  const rail: ConversationRailRow[] = conversations.items.map((conversation) => ({
    conversation,
    lastActivityLabel: formatNepaliDate(conversation.updatedAt, { format: "bs" }),
  }));

  return (
    <ChatShell>
      <ChatClient key={transcript?.conversation.id ?? "none"} rail={rail} transcript={transcript} />
    </ChatShell>
  );
}

function ChatShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <header className="mb-6 space-y-1">
          <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Agent" }]} />
          <h1 className="text-text-primary text-2xl font-semibold">Agent</h1>
          <p className="text-text-muted text-sm">
            Ask about the fleet, or tell the agent what to look up. Every tool call is recorded.
          </p>
        </header>
        {children}
      </div>
    </main>
  );
}
