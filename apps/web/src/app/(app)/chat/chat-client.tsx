"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  actionBadgeVariant,
  AGENT_MESSAGE_MAX_LENGTH,
  entityPathFor,
  formatLatencyMs,
  linkifyAppPaths,
} from "@/lib/agent-chat";

import { createConversationAction, postTurnAction, uploadAttachmentAction } from "./actions";
import type {
  AgentAction,
  AgentAttachment,
  AgentMessage,
  AgentTranscript,
  ConversationRailRow,
} from "./types";

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

/** The pending-chip state: one uploaded-but-unsent photo (ADR-0044 c7). */
interface PendingAttachment {
  attachment: AgentAttachment;
  /** A local object URL for the chip thumbnail — revoked on send/discard. */
  previewUrl: string;
}

/** Downscale a picked photo client-side (DESIGN.md §"Agent chat" Attachments):
 * canvas re-encode to JPEG, longest edge ~2048 px — turns multi-MB phone
 * photos into upload-friendly bytes. Degrades to the ORIGINAL file when the
 * browser cannot decode it (the API's 10 MB limit + sniff still govern). */
async function downscaleImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > 2048 ? 2048 / longest : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (context === null) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    return blob ?? file;
  } catch {
    return file;
  }
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ChatClient({ rail, transcript }: ChatClientProps): React.ReactElement {
  const router = useRouter();

  const [messages, setMessages] = useState<AgentMessage[]>(transcript?.messages ?? []);
  const [attachments, setAttachments] = useState<AgentAttachment[]>(transcript?.attachments ?? []);
  const [actions, setActions] = useState<AgentAction[]>(transcript?.actions ?? []);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [errorLine, setErrorLine] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // A conversation created for an upload before the first send: held locally
  // (no navigation yet — navigating would remount the island and drop the
  // pending chip); send() completes the ?c= handoff.
  const [createdConversationId, setCreatedConversationId] = useState<string | null>(null);

  const selectedId = transcript?.conversation.id ?? null;

  // Transcript thumbnails: the server's message→attachment join, by id.
  const attachmentsByMessage = useMemo(() => {
    const byMessage = new Map<string, AgentAttachment[]>();
    for (const attachment of attachments) {
      if (attachment.messageId === null) continue;
      const list = byMessage.get(attachment.messageId) ?? [];
      list.push(attachment);
      byMessage.set(attachment.messageId, list);
    }
    return byMessage;
  }, [attachments]);

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

  /** The conversation to act against, creating one lazily (held locally
   * until send() completes the ?c= handoff — see createdConversationId). */
  async function ensureConversationId(): Promise<string | null> {
    if (selectedId !== null) return selectedId;
    if (createdConversationId !== null) return createdConversationId;
    const created = await createConversationAction();
    if (!created.ok) {
      setErrorLine(created.message);
      return null;
    }
    setCreatedConversationId(created.conversation.id);
    return created.conversation.id;
  }

  async function pickPhoto(file: File): Promise<void> {
    if (uploading || pending) return;
    setUploading(true);
    setErrorLine(null);
    try {
      const conversationId = await ensureConversationId();
      if (conversationId === null) return;

      const blob = await downscaleImage(file);
      const form = new FormData();
      form.append("file", blob, "photo.jpg");
      const result = await uploadAttachmentAction(conversationId, form);
      if (!result.ok) {
        setErrorLine(result.message);
        return;
      }
      // Replace any earlier pending photo (one attachment per turn, v1).
      setPendingAttachment((prior) => {
        if (prior !== null) URL.revokeObjectURL(prior.previewUrl);
        return { attachment: result.attachment, previewUrl: URL.createObjectURL(blob) };
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  }

  function discardPendingPhoto(): void {
    setPendingAttachment((prior) => {
      if (prior !== null) URL.revokeObjectURL(prior.previewUrl);
      return null;
    });
    // The uploaded row stays unclaimed server-side; the 180-day transcript
    // prune reaps it with its conversation — no delete round-trip needed.
  }

  async function send(): Promise<void> {
    const content = draft.trim();
    // A photo may travel captionless (ADR-0044 c7).
    if ((content.length === 0 && pendingAttachment === null) || pending || uploading) return;
    setPending(true);
    setErrorLine(null);
    try {
      // First message with nothing selected: create the conversation, then
      // post into it — the composer works from a blank /chat (the rail's
      // "New conversation" button remains for starting a fresh thread while
      // one is selected).
      const conversationId = await ensureConversationId();
      if (conversationId === null) return;

      const result = await postTurnAction(
        conversationId,
        content,
        pendingAttachment?.attachment.id,
      );
      if (!result.ok) {
        setErrorLine(
          result.status === 409
            ? "A turn is already running for this conversation."
            : result.message,
        );
        return;
      }

      setMessages((prior) => [...prior, ...result.turn.messages]);
      setAttachments((prior) => [...prior, ...result.turn.attachments]);
      setActions((prior) => [...prior, ...result.turn.actions]);
      setDraft("");
      discardPendingPhoto();

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
                attachments={attachmentsByMessage.get(message.id) ?? []}
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
          {uploading ? <p className="text-text-muted mb-2 text-xs">Uploading photo…</p> : null}
          {pendingAttachment !== null ? (
            <div className="border-border-subtle bg-surface-raised mb-2 flex items-center gap-2 rounded border p-2">
              {/* The chip preview is the local object URL — the server copy
                  streams through the authed proxy only after it is sent. */}
              <img
                src={pendingAttachment.previewUrl}
                alt="Attached photo (pending)"
                className="h-10 w-10 rounded object-cover"
              />
              <span className="text-text-muted text-xs">
                Photo · {formatSize(pendingAttachment.attachment.sizeBytes)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove the attached photo"
                onClick={discardPendingPhoto}
                disabled={pending}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
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
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void pickPhoto(file);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Attach a photo (fuel or expense receipt, vendor bill, or a vehicle/driver document)"
                onClick={() => fileInputRef.current?.click()}
                disabled={pending || uploading}
              >
                <Paperclip className="h-4 w-4" />
              </Button>
              <span className="text-text-muted text-xs">
                Enter to send · Shift+Enter for a new line
              </span>
            </div>
            <Button
              type="button"
              onClick={() => void send()}
              disabled={pending || uploading || (draft.trim() === "" && pendingAttachment === null)}
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
  attachments,
}: {
  message: AgentMessage;
  actions: AgentAction[];
  attachments: AgentAttachment[];
}): React.ReactElement | null {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="border-border-subtle bg-surface-raised max-w-[85%] rounded border p-3 text-sm whitespace-pre-wrap">
          {attachments.map((attachment) => (
            /* Bounded thumbnail streaming through the authed proxy; opening
               it is the full view (same route — Tier-2 bytes, no public
               URL). A captionless photo message renders thumbnail-only. */
            <a
              key={attachment.id}
              href={`/api/agent-attachments/${attachment.id}`}
              target="_blank"
              rel="noreferrer"
              className="mb-2 block"
            >
              <img
                src={`/api/agent-attachments/${attachment.id}`}
                alt="Attached photo"
                className="border-border-subtle max-h-48 rounded border object-contain"
              />
            </a>
          ))}
          {message.content !== "" ? message.content : null}
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
// never from model text. Write tools (A7) populate resultEntityType/Id and
// the card carries its ONE contextual link to the affected record
// (anti-pattern #3); read dispatches have no entity and render no link.
function ActionCard({ action }: { action: AgentAction }): React.ReactElement {
  const entityHref =
    action.resultEntityType !== null && action.resultEntityId !== null
      ? entityPathFor(action.resultEntityType, action.resultEntityId)
      : null;
  return (
    <div className="border-border-subtle bg-surface-raised rounded border p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs">{action.toolName}</span>
        <Badge variant={actionBadgeVariant(action.status)}>{action.status}</Badge>
        <span className="text-text-muted text-xs tabular-nums">
          {formatLatencyMs(action.latencyMs)}
        </span>
        {entityHref !== null ? (
          <Link href={entityHref} className="text-text-accent text-xs underline underline-offset-2">
            {entityHref}
          </Link>
        ) : null}
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
