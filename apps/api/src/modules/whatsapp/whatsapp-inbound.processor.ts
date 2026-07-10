import { Processor, WorkerHost } from "@nestjs/bullmq";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { Prisma, type WhatsAppMessageLog } from "@prisma/client";
import type { Job } from "bullmq";

import { env } from "../../config/env";
import type { Actor } from "../auth/driver-scope.service";
// The injected services are resolved via emitDecoratorMetadata; value imports
// for DI, the same pattern as every worker.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AgentAttachmentsService } from "../agent/agent-attachments.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { AgentService, type AgentTurnResult } from "../agent/agent.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
import { normalizeE164 } from "./phone-e164";
import { chunkWhatsAppBody, renderTurnForWhatsApp } from "./render-turn";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TwilioMediaClient } from "./twilio-media.client";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WhatsAppIdentityService } from "./whatsapp-identity.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { WhatsAppSender } from "./whatsapp-sender";
import {
  WHATSAPP_DAILY_INBOUND_CAP,
  WHATSAPP_INBOUND_CONCURRENCY,
  WHATSAPP_INBOUND_JOB_NAME,
  WHATSAPP_INBOUND_QUEUE,
} from "./whatsapp.constants";
import type { WhatsAppInboundJobData } from "./whatsapp.schemas";

// The WhatsApp inbound worker (ADR-0046 c3) — the in-process turn runner, on
// the NotificationProcessor shape (@Processor + WorkerHost, job-name switch).
// In-process per ADR-0029 c5, which is load-bearing here: the agent's
// per-conversation in-flight lock is in-memory, so worker and HTTP turns
// contend on the SAME lock and a same-conversation collision surfaces as the
// 409 this worker retries on.
//
// Ordered steps per ADR-0046 c3, each an AUDITED WhatsAppMessageLog outcome:
//   (a) CLAIM by MessageSid — the create against the @unique column IS the
//       dedup: a Twilio retry or a signature replay loses the race and skips
//       (ADR-0046 c7/c9A — the signature has no nonce; this row is the replay
//       defense). Our own BullMQ retry re-claims its row atomically instead.
//   (b) STOP/START keyword handling on the link (before any authz — a START
//       must find a deactivated link that resolveSenderToActor fails closed on).
//   (c) resolve + turn-time authz via resolveSenderToActor — the chokepoint
//       (c9B); an unmapped/unauthorized sender is a SILENT drop + audit row,
//       never a reply (c9C open-relay: replies go only to the verified,
//       linked From — and here only ever to the LINK's stored canonical
//       phone, never anything from message content).
//   (d) per-user daily cap (c8 — every inbound is a billed outbound).
//   (e) get-or-create the link's stable conversation (c4).
//   (f) runTurn as the resolved human.
//   (g) 409 collision → rethrow so BullMQ's backoff re-enqueues (never drop);
//       ANY OTHER turn failure is terminal — an agent turn is NOT idempotent
//       (it may have executed writes before failing), so auto-re-running it
//       is exactly the double-fire the dedup exists to prevent.
//   (h) render (the c6 honesty renderer) → chunk → send, one outbound ledger
//       row per segment.
/** The server-authored reply when an inbound photo cannot be received (W5).
 * Server speech as itself — the c4c rule cuts both ways, and silence here
 * would let the turn answer a caption as if the photo had arrived. */
export const MEDIA_FAILED_NOTICE =
  "Your photo could not be received (download or unsupported file type — JPEG, PNG, or " +
  "WEBP under 10 MB). Send it again, or type the details instead.";

@Processor(WHATSAPP_INBOUND_QUEUE, { concurrency: WHATSAPP_INBOUND_CONCURRENCY })
export class WhatsAppInboundProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: WhatsAppIdentityService,
    private readonly agent: AgentService,
    private readonly sender: WhatsAppSender,
    private readonly attachments: AgentAttachmentsService,
    private readonly media: TwilioMediaClient,
  ) {
    super();
  }

  async process(job: Job<WhatsAppInboundJobData>): Promise<void> {
    switch (job.name) {
      case WHATSAPP_INBOUND_JOB_NAME:
        return this.handleInbound(job.data, job.attemptsMade);
      default:
        throw new Error(`Unknown job "${job.name}" on the ${WHATSAPP_INBOUND_QUEUE} queue.`);
    }
  }

  /**
   * One inbound message, start to finish. Public and plainly typed (data +
   * attemptsMade rather than a bullmq Job) so the integration tests drive the
   * REAL pipeline against real Postgres without constructing a Job or a Redis
   * connection; `process` above is the thin WorkerHost adapter.
   * `attemptsMade` participates in the dedup reclaim — see step (a).
   */
  async handleInbound(data: WhatsAppInboundJobData, attemptsMade: number): Promise<void> {
    const { messageSid, from, body } = data;

    // The ledger's phone value: canonical E.164 when the From parses (so
    // unmapped-number audit rows still group per sender), the raw value
    // bounded otherwise. Tier-2 either way — stored, never logged.
    let canonicalPhone: string | null = null;
    try {
      canonicalPhone = normalizeE164(from);
    } catch {
      canonicalPhone = null;
    }
    const phoneForLedger = canonicalPhone ?? from.slice(0, 64);

    // (a) CLAIM. The @unique(providerSid) create is the atomic dedup gate
    // (ADR-0046 c7): exactly one job ever owns a MessageSid. P2002 means the
    // SID exists — either a true duplicate/replay (skip), or OUR OWN earlier
    // attempt (this job retrying after a 409 or a crash): reclaim atomically
    // by flipping waiting_retry → processing. A first-delivery job
    // (attemptsMade 0) may only reclaim waiting_retry; a RETRYING job may also
    // reclaim a stale "processing" left by its own crashed prior attempt — a
    // concurrent Twilio duplicate is always attemptsMade 0, so it can never
    // steal an in-flight row.
    let row: WhatsAppMessageLog;
    try {
      row = await this.prisma.whatsAppMessageLog.create({
        data: {
          direction: "inbound",
          phone: phoneForLedger,
          providerSid: messageSid,
          status: "processing",
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      const reclaim = await this.prisma.whatsAppMessageLog.updateMany({
        where: {
          providerSid: messageSid,
          status: attemptsMade > 0 ? { in: ["waiting_retry", "processing"] } : "waiting_retry",
        },
        data: { status: "processing" },
      });
      if (reclaim.count === 0) {
        // Terminal or owned by a live attempt — a duplicate delivery or a
        // replayed POST. Skip without a turn, without a reply (c9A).
        return;
      }
      row = await this.prisma.whatsAppMessageLog.findUniqueOrThrow({
        where: { providerSid: messageSid },
      });
    }

    const link = await this.identity.findLinkForPhone(from);

    // (b) Opt-out / opt-in keywords (WhatsApp policy; runbook §Handling
    // opt-out). Idempotent by design: STOP always leaves the link inactive,
    // START always leaves it active. Neither replies — answering a STOP
    // violates the opt-out, and a courtesy reply to START is a billed message
    // carrying no information. START is user-recoverable reactivation of an
    // operator-provisioned link only (it creates nothing); every subsequent
    // message still passes the turn-time authz below, so reactivation grants
    // nothing the live role does not hold.
    const keyword = body.trim().toUpperCase();
    if (keyword === "STOP" || keyword === "START") {
      if (link === null) {
        await this.finish(row.id, "dropped_unmapped");
        return;
      }
      await this.prisma.agentPhoneLink.update({
        where: { id: link.id },
        data: { active: keyword === "START" },
      });
      await this.finish(row.id, keyword === "STOP" ? "opt_out" : "opt_in");
      return;
    }

    if (link === null) {
      // Unparseable or unmapped number: silent drop + audit (ADR-0046 §picks
      // — no courtesy reply: it would confirm a live line and cost money).
      await this.finish(row.id, "dropped_unmapped");
      return;
    }

    // (c) The authorization chokepoint (c9B): active link + live-role
    // agent:use, or nothing runs. ForbiddenException is the resolver's
    // fail-closed contract; anything else (the DB down) is a real failure
    // that must retry, not masquerade as a drop.
    let actor: Actor;
    try {
      actor = await this.identity.resolveSenderToActor(from);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        await this.finish(row.id, "dropped_unauthorized");
        return;
      }
      throw error;
    }

    // (d) The per-user daily cap (c8). The claim row above is already in the
    // count, so the CAP-th message of the day still processes and the
    // CAP+1-th drops.
    const utcMidnight = new Date();
    utcMidnight.setUTCHours(0, 0, 0, 0);
    const todayCount = await this.prisma.whatsAppMessageLog.count({
      where: {
        direction: "inbound",
        phone: link.phoneE164,
        createdAt: { gte: utcMidnight },
      },
    });
    if (todayCount > WHATSAPP_DAILY_INBOUND_CAP) {
      await this.finish(row.id, "rate_limited");
      return;
    }

    // Nothing to act on: no text and no media (a sticker, a location share, a
    // reaction — shapes W5 does not consume). Dropping here spends no LLM
    // tokens on an empty turn and creates no conversation for it; the ledger
    // row is the audit.
    if (body.trim() === "" && data.mediaUrl === undefined) {
      await this.finish(row.id, "ignored_empty");
      return;
    }

    // (e) Get-or-create the link's stable conversation (c4). The pointer read
    // is a same-module read of the link plus a shared-Prisma read of the
    // conversation row (the ReportsService public-data-seam precedent);
    // CREATION goes through AgentService's public interface. A stale pointer
    // (pruned conversation) or — defensively — a pointer at someone else's
    // conversation falls through to a fresh create.
    let conversationId: string | null = null;
    if (link.conversationId !== null) {
      const existing = await this.prisma.agentConversation.findUnique({
        where: { id: link.conversationId },
        select: { id: true, userId: true },
      });
      if (existing !== null && existing.userId === actor.userId) {
        conversationId = existing.id;
      }
    }
    if (conversationId === null) {
      const created = await this.agent.createConversation(actor);
      conversationId = created.id;
      await this.prisma.agentPhoneLink.update({
        where: { id: link.id },
        data: { conversationId },
      });
    }

    // (W5) The photo path — download the signature-verified media item and
    // store it as a first-class AgentAttachment (magic-byte sniff + 10 MB cap
    // re-run inside upload(), never trusting Twilio's declared type). The
    // attachment then rides the turn exactly like a web-composer photo
    // (claim-on-send, extraction step 0), and with the image intake PAUSED
    // (AGENT_OCR_URL unset — the standing ADR-0044 decision) the turn
    // degrades to the honest not-configured notice: built, inert. Any
    // download/validation failure drops the WHOLE message with a
    // server-authored notice — running a caption-only turn would answer as
    // if the photo had arrived.
    let attachmentId: string | undefined;
    if (data.mediaUrl !== undefined) {
      try {
        const downloaded = await this.media.download(data.mediaUrl);
        const attachment = await this.attachments.upload(
          conversationId,
          {
            buffer: downloaded.bytes,
            mimetype: downloaded.declaredContentType ?? "application/octet-stream",
            size: downloaded.bytes.length,
            originalname: "whatsapp-photo",
          },
          actor,
        );
        attachmentId = attachment.id;
      } catch {
        await this.sendSegment(link.phoneE164, MEDIA_FAILED_NOTICE, conversationId, null);
        await this.finish(row.id, "media_failed", conversationId);
        return;
      }
    }

    // (f) The turn, as the resolved human (ADR-0021 / ADR-0043 c1).
    let result: AgentTurnResult;
    try {
      result = await this.agent.runTurn(conversationId, body, actor, attachmentId);
    } catch (error) {
      if (error instanceof ConflictException) {
        // (g) Same-conversation collision: another turn holds the in-flight
        // lock. Park the row and rethrow — BullMQ's backoff re-enqueues
        // (ADR-0046 c3: re-enqueue, never drop), and the reclaim in (a)
        // picks the row back up on the retry attempt.
        await this.finish(row.id, "waiting_retry");
        throw error;
      }
      // Any other failure is TERMINAL: the turn is not idempotent (writes may
      // have executed before the failure), so re-running it risks the exact
      // double-fire the dedup exists to prevent. The ledger records it; the
      // job completes so BullMQ does not retry.
      await this.finish(row.id, "failed");
      return;
    }

    // (h) Render (c6) → chunk → send. The reply goes ONLY to the link's
    // stored canonical phone (c9C — never a number from message content).
    const rendered = renderTurnForWhatsApp(
      { messages: result.messages, actions: result.actions },
      { webPublicUrl: env.WEB_PUBLIC_URL },
    );
    const assistantRow =
      [...result.messages].reverse().find((m) => m.role === "assistant" && m.content !== "") ??
      null;
    for (const chunk of chunkWhatsAppBody(rendered)) {
      const delivered = await this.sendSegment(
        link.phoneE164,
        chunk,
        conversationId,
        assistantRow?.id ?? null,
      );
      if (!delivered) {
        // A failed segment: the rest is withheld (out-of-order fragments
        // would garble the reply). The turn's writes stand — the ledger row
        // is the operator's signal. Delivery-status tracking past
        // sync-accepted is the deferred StatusCallback (ADR-0046 c7).
        break;
      }
    }

    const userRow = result.messages.find((m) => m.role === "user") ?? null;
    await this.prisma.whatsAppMessageLog.update({
      where: { id: row.id },
      data: { status: "processed", conversationId, messageId: userRow?.id ?? null },
    });
  }

  /** Send ONE outbound segment and write its ledger row (`sent` + provider
   * SID, or `failed` with providerSid null). Never throws — the boolean lets
   * the caller decide whether to continue a multi-segment reply. */
  private async sendSegment(
    phoneE164: string,
    bodyText: string,
    conversationId: string | null,
    messageId: string | null,
  ): Promise<boolean> {
    try {
      const sent = await this.sender.send({ to: phoneE164, body: bodyText });
      await this.prisma.whatsAppMessageLog.create({
        data: {
          direction: "outbound",
          phone: phoneE164,
          providerSid: sent.sid ?? null,
          status: "sent",
          conversationId,
          messageId,
        },
      });
      return true;
    } catch {
      await this.prisma.whatsAppMessageLog.create({
        data: {
          direction: "outbound",
          phone: phoneE164,
          providerSid: null,
          status: "failed",
          conversationId,
          messageId,
        },
      });
      return false;
    }
  }

  /** Set a terminal status on the inbound claim row. */
  private async finish(rowId: string, status: string, conversationId?: string): Promise<void> {
    await this.prisma.whatsAppMessageLog.update({
      where: { id: rowId },
      data: { status, ...(conversationId !== undefined ? { conversationId } : {}) },
    });
  }
}
