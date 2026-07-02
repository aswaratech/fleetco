"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  actionBadgeVariant,
  AGENT_MESSAGE_MAX_LENGTH,
  formatLatencyMs,
  linkifyAppPaths,
} from "@/lib/agent-chat";

import { createConversationAction, postTurnAction } from "./actions";
import type { AgentAction, AgentMessage, AgentTranscript, ConversationRailRow } from "./types";

// The chat island (ADR-0043 A6, DESIGN.md §"Agent chat"): the conversation
// rail, the transcript, and the composer. State model: the server page hands
// in the STORED rail + transcript; each sent turn appends the action's
// returned messages/actions locally (no navigation, no refetch of what the
// response already carries). Switching conversations rides the URL (`?c=`),
// which re-renders the server page — the island re-mounts keyed by
// conversation id.
//
// Tier-2 discipline: message content stays in React state — never in
// console.*, never in URLs (only the conversation id rides `?c=`).

interface ChatClientProps {
  rail: ConversationRailRow[];
  transcript: AgentTranscript | null;
}

export function ChatClient({ rail, transcript }: ChatClientProps): React.ReactElement {
  const router = useRouter();

  const [messages, setMessages] = useState<AgentMessage[]>(transcript?.messages ?? []);
  const [actions, setActions] = useState<AgentAction[]>(transcript?.actions ?? []);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [errorLine, setErrorLine] = useState<string | null>(null);

  const selectedId = transcript?.conversation.id ?? null;

  // Action cards render under the assistant message whose tool_calls
  // produced them (messageId links the two — the server's join, not a
  // client-side guess).
  const actionsByMessage = useMemo(() => {
    const byMessage = new Map<string, AgentAction[]>();
    for (const action of actions) {
      if (action.messageId === null) continue;
      const list = byMessage.get(action.messageId) ?? [];
      list.push(action);
      byMessage.set(action.messageId, list);
    }
    return byMessage;
  }, [actions]);

  async function send(): Promise<void> {
    const content = draft.trim();
    if (content.length === 0 || pending) return;
    setPending(true);
    setErrorLine(null);
    try {
      // First message with nothing selected: create the conversation, then
      // post into it — the composer works from a blank /chat (the rail's
      // "New conversation" button remains for starting a fresh thread while
      // one is selected).
      let conversationId = selectedId;
      if (conversationId === null) {
        const created = await createConversationAction();
        if (!created.ok) {
          setErrorLine(created.message);
          return;
        }
        conversationId = created.conversation.id;
      }

      const result = await postTurnAction(conversationId, content);
      if (!result.ok) {
        setErrorLine(
          result.status === 409
            ? "A turn is already running for this conversation."
            : result.message,
        );
        return;
      }

      setMessages((prior) => [...prior, ...result.turn.messages]);
      setActions((prior) => [...prior, ...result.turn.actions]);
      setDraft("");

      if (selectedId === null) {
        // Land on the new conversation's URL; the server re-render brings
        // the rail row (title, BS date label) with it.
        router.replace(`/chat?c=${conversationId}`, { scroll: false });
      }
    } finally {
      setPending(false);
    }
  }

  async function startNewConversation(): Promise<void> {
    if (pending) return;
    setErrorLine(null);
    const created = await createConversationAction();
    if (!created.ok) {
      setErrorLine(created.message);
      return;
    }
    router.push(`/chat?c=${created.conversation.id}`, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      {/* Conversation rail */}
      <aside className="w-full shrink-0 md:w-64">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void startNewConversation()}
          disabled={pending}
        >
          New conversation
        </Button>
        {rail.length === 0 ? (
          <p className="text-text-muted mt-4 text-sm">No conversations.</p>
        ) : (
          <ul className="mt-4 space-y-1">
            {rail.map(({ conversation, lastActivityLabel }) => (
              <li key={conversation.id}>
                <Link
                  href={`/chat?c=${conversation.id}`}
                  aria-current={conversation.id === selectedId ? "page" : undefined}
                  className={`block rounded px-3 py-2 text-sm ${
                    conversation.id === selectedId
                      ? "bg-surface-muted text-text-primary"
                      : "text-text-secondary hover:bg-surface-muted hover:text-text-primary"
                  }`}
                >
                  <span className="block truncate">
                    {conversation.title ?? (
                      <span className="text-text-muted">New conversation</span>
                    )}
                  </span>
                  <span className="text-text-muted block text-xs">{lastActivityLabel}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Transcript + composer */}
      <section className="min-w-0 flex-1">
        <div className="space-y-4">
          {messages.length === 0 ? (
            <p className="text-text-muted text-sm">
              Ask about the fleet — vehicles, trips, fuel, costs, maintenance.
            </p>
          ) : (
            messages.map((message) => (
              <MessageBlock
                key={message.id}
                message={message}
                actions={actionsByMessage.get(message.id) ?? []}
              />
            ))
          )}
          {pending ? (
            <p className="text-text-muted text-sm">
              Waiting for the agent. This can take up to a minute.
            </p>
          ) : null}
        </div>

        <div className="border-border-subtle mt-6 border-t pt-4">
          {errorLine !== null ? (
            <p className="text-status-error mb-2 text-sm" role="alert">
              {errorLine}
            </p>
          ) : null}
          <Textarea
            value={draft}
            maxLength={AGENT_MESSAGE_MAX_LENGTH}
            placeholder="Message the agent…"
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-text-muted text-xs">
              Enter to send · Shift+Enter for a new line
            </span>
            <Button
              type="button"
              onClick={() => void send()}
              disabled={pending || draft.trim() === ""}
            >
              Send
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

function MessageBlock({
  message,
  actions,
}: {
  message: AgentMessage;
  actions: AgentAction[];
}): React.ReactElement | null {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="border-border-subtle bg-surface-raised max-w-[85%] rounded border p-3 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    // Server-authored notices (budget exhaustion, provider failure) — facts,
    // centered and quiet.
    return <p className="text-text-muted text-center text-xs">{message.content}</p>;
  }

  // Assistant. Rounds that carried only tool calls persist with empty
  // content and render nothing themselves — their action cards carry the
  // information.
  const hasText = message.content !== "";
  if (!hasText && actions.length === 0) return null;

  return (
    <div className="max-w-[85%] space-y-2">
      {hasText ? <AssistantText content={message.content} /> : null}
      {actions.map((action) => (
        <ActionCard key={action.id} action={action} />
      ))}
    </div>
  );
}

// Assistant text is UNTRUSTED model output: only allowlisted app routes
// become links (DESIGN.md §"Agent chat" — the prompt-injection posture
// applied to rendering). Everything else renders as inert text.
function AssistantText({ content }: { content: string }): React.ReactElement {
  const segments = linkifyAppPaths(content);
  return (
    <p className="text-text-primary text-sm whitespace-pre-wrap">
      {segments.map((segment, index) =>
        segment.kind === "link" ? (
          <Link
            key={index}
            href={segment.href}
            className="text-text-accent underline underline-offset-2"
          >
            {segment.text}
          </Link>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

// The c4c honesty rule: this card renders from the server's AgentAction row,
// never from model text. Stage one (read tools) has no entity deep-link;
// A7/A8 populate resultEntityType/Id and the card gains its one contextual
// link (anti-pattern #3).
function ActionCard({ action }: { action: AgentAction }): React.ReactElement {
  return (
    <div className="border-border-subtle bg-surface-raised rounded border p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs">{action.toolName}</span>
        <Badge variant={actionBadgeVariant(action.status)}>{action.status}</Badge>
        <span className="text-text-muted text-xs tabular-nums">
          {formatLatencyMs(action.latencyMs)}
        </span>
      </div>
      <details className="mt-2">
        <summary className="text-text-muted cursor-pointer text-xs">Details</summary>
        <pre className="text-text-secondary mt-1 overflow-x-auto text-xs">
          {JSON.stringify(action.argsJson, null, 2)}
        </pre>
      </details>
    </div>
  );
}
