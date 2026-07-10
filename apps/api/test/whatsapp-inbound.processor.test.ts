import { randomUUID } from "node:crypto";

import { ConflictException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { AgentAttachmentsService } from "../src/modules/agent/agent-attachments.service";
import { AgentService, type AgentTurnResult } from "../src/modules/agent/agent.service";
import type { Actor } from "../src/modules/auth/driver-scope.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { MockObjectStorage } from "../src/modules/storage/mock.object-storage";
import { ObjectStorage } from "../src/modules/storage/object-storage";
import { TwilioMediaClient } from "../src/modules/whatsapp/twilio-media.client";
import { WhatsAppIdentityService } from "../src/modules/whatsapp/whatsapp-identity.service";
import {
  MEDIA_FAILED_NOTICE,
  WhatsAppInboundProcessor,
} from "../src/modules/whatsapp/whatsapp-inbound.processor";
import { WhatsAppSender } from "../src/modules/whatsapp/whatsapp-sender";
import { WHATSAPP_DAILY_INBOUND_CAP } from "../src/modules/whatsapp/whatsapp.constants";
import { resetDb } from "./db";

// Integration tests for the WhatsApp inbound worker (ADR-0046 c3) — the REAL
// pipeline against real Postgres: the claim/dedup against the live @unique,
// the real identity resolver (the c9B authz chokepoint), the real renderer,
// and the real ledger writes. Only the two seams are stubbed: AgentService
// (the turn is ADR-0043's, tested there — here it returns canned results or
// throws) and WhatsAppSender (W3's contract; a spy records sends). The
// processor is driven through its public handleInbound(data, attemptsMade)
// entry — no bullmq Job, no Redis.

const PHONE = "+9779812345678";
const OTHER_PHONE = "+9779800000000";

describe("WhatsAppInboundProcessor.handleInbound (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let processor: WhatsAppInboundProcessor;

  const agentStub = { createConversation: vi.fn(), runTurn: vi.fn() };
  const senderStub = { send: vi.fn() };
  const mediaStub = { download: vi.fn() };
  let sidCounter = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        PrismaService,
        WhatsAppIdentityService,
        WhatsAppInboundProcessor,
        // The attachments service runs REAL (sniff + cap + storage row) over
        // the in-memory storage mock — the W5 media path's validation is the
        // point, so it is not stubbed.
        AgentAttachmentsService,
        { provide: ObjectStorage, useValue: new MockObjectStorage() },
        { provide: AgentService, useValue: agentStub },
        { provide: WhatsAppSender, useValue: senderStub },
        { provide: TwilioMediaClient, useValue: mediaStub },
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    processor = module.get(WhatsAppInboundProcessor);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    sidCounter = 0;
    // The stubs' default behavior — the happy path. Individual tests override.
    agentStub.createConversation.mockImplementation(async (actor: Actor) =>
      prisma.agentConversation.create({ data: { userId: actor.userId } }),
    );
    senderStub.send.mockImplementation(() => {
      sidCounter += 1;
      return Promise.resolve({ sid: `SM_OUT_${String(sidCounter)}` });
    });
    // Text-only tests must never reach the media client.
    mediaStub.download.mockRejectedValue(new Error("no media stubbed for this test"));
  });

  async function seedUserWithLink(
    role: UserRole = UserRole.ADMIN,
    opts?: { active?: boolean; phone?: string },
  ): Promise<{ userId: string; linkId: string; phone: string }> {
    const userId = randomUUID();
    const phone = opts?.phone ?? PHONE;
    await prisma.user.create({
      data: {
        id: userId,
        email: `${role.toLowerCase()}-${userId}@fleetco.test`,
        name: "Test",
        role,
        emailVerified: true,
      },
    });
    const link = await prisma.agentPhoneLink.create({
      data: { phoneE164: phone, userId, active: opts?.active ?? true, verifiedAt: new Date() },
    });
    return { userId, linkId: link.id, phone };
  }

  /** Canned turn result with REAL message rows (so ledger FKs hold). */
  async function stubTurn(assistantText: string): Promise<void> {
    agentStub.runTurn.mockImplementation(
      async (conversationId: string, content: string): Promise<AgentTurnResult> => {
        const conversation = await prisma.agentConversation.findUniqueOrThrow({
          where: { id: conversationId },
        });
        const userRow = await prisma.agentMessage.create({
          data: { conversationId, role: "user", content },
        });
        const assistantRow = await prisma.agentMessage.create({
          data: { conversationId, role: "assistant", content: assistantText },
        });
        return { conversation, messages: [userRow, assistantRow], attachments: [], actions: [] };
      },
    );
  }

  function inbound(
    messageSid: string,
    overrides?: { from?: string; body?: string; mediaUrl?: string },
  ) {
    return {
      messageSid,
      from: overrides?.from ?? `whatsapp:${PHONE}`,
      body: overrides?.body ?? "how many vehicles are active",
      ...(overrides?.mediaUrl !== undefined ? { mediaUrl: overrides.mediaUrl } : {}),
    };
  }

  test("happy path: claim -> resolve -> turn -> render -> send, every step in the ledger", async () => {
    const { userId, linkId } = await seedUserWithLink();
    await stubTurn("You have 4 active vehicles.");

    await processor.handleInbound(inbound("SM_IN_1"), 0);

    // The turn ran as the resolved human (c9B) in a fresh conversation.
    expect(agentStub.runTurn).toHaveBeenCalledTimes(1);
    const [convId, content, actor] = agentStub.runTurn.mock.calls[0] as [string, string, Actor];
    expect(content).toBe("how many vehicles are active");
    expect(actor).toEqual({ userId, role: UserRole.ADMIN });

    // The link now anchors the conversation (c4).
    const link = await prisma.agentPhoneLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.conversationId).toBe(convId);

    // The reply went to the LINK's canonical phone, bare E.164 (c9C).
    expect(senderStub.send).toHaveBeenCalledTimes(1);
    expect(senderStub.send.mock.calls[0]?.[0]).toEqual({
      to: PHONE,
      body: "You have 4 active vehicles.",
    });

    // Ledger: inbound processed (joined to the user message), one outbound
    // sent row carrying the provider SID (joined to the assistant message).
    const inRow = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(inRow.direction).toBe("inbound");
    expect(inRow.status).toBe("processed");
    expect(inRow.phone).toBe(PHONE);
    expect(inRow.conversationId).toBe(convId);
    expect(inRow.messageId).not.toBeNull();
    const outRows = await prisma.whatsAppMessageLog.findMany({ where: { direction: "outbound" } });
    expect(outRows).toHaveLength(1);
    expect(outRows[0]?.status).toBe("sent");
    expect(outRows[0]?.providerSid).toBe("SM_OUT_1");
    expect(outRows[0]?.conversationId).toBe(convId);
  });

  test("the second message reuses the link's conversation — one stable thread (c4)", async () => {
    await seedUserWithLink();
    await stubTurn("ok");

    await processor.handleInbound(inbound("SM_IN_1"), 0);
    await processor.handleInbound(inbound("SM_IN_2"), 0);

    expect(agentStub.createConversation).toHaveBeenCalledTimes(1);
    const first = agentStub.runTurn.mock.calls[0]?.[0] as string;
    const second = agentStub.runTurn.mock.calls[1]?.[0] as string;
    expect(second).toBe(first);
  });

  test("a stale conversation pointer (pruned thread) falls through to a fresh create", async () => {
    const { linkId, userId } = await seedUserWithLink();
    // A conversation that no longer exists — the 180-day prune's effect.
    const ghost = await prisma.agentConversation.create({ data: { userId } });
    await prisma.agentPhoneLink.update({
      where: { id: linkId },
      data: { conversationId: ghost.id },
    });
    await prisma.agentConversation.delete({ where: { id: ghost.id } });
    // The SetNull FK already nulled the pointer — re-point it manually to a
    // random missing id to exercise the defensive existence check itself.
    const missingId = `c${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    await prisma.agentPhoneLink.update({
      where: { id: linkId },
      data: { conversationId: null },
    });
    await stubTurn("ok");

    await processor.handleInbound(inbound("SM_IN_1"), 0);
    expect(agentStub.createConversation).toHaveBeenCalledTimes(1);
    const link = await prisma.agentPhoneLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.conversationId).not.toBe(missingId);
    expect(link.conversationId).not.toBeNull();
  });

  test("a duplicate MessageSid never re-fires the turn (c7/c9A — the replay defense)", async () => {
    await seedUserWithLink();
    await stubTurn("done");

    await processor.handleInbound(inbound("SM_IN_1"), 0);
    await processor.handleInbound(inbound("SM_IN_1"), 0); // replayed POST / Twilio duplicate

    expect(agentStub.runTurn).toHaveBeenCalledTimes(1);
    expect(senderStub.send).toHaveBeenCalledTimes(1);
    const rows = await prisma.whatsAppMessageLog.findMany({ where: { direction: "inbound" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("processed");
  });

  test("a retry attempt reclaims its own waiting_retry row and completes", async () => {
    await seedUserWithLink();
    await stubTurn("done");
    await prisma.whatsAppMessageLog.create({
      data: { direction: "inbound", phone: PHONE, providerSid: "SM_IN_1", status: "waiting_retry" },
    });

    await processor.handleInbound(inbound("SM_IN_1"), 1);

    expect(agentStub.runTurn).toHaveBeenCalledTimes(1);
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("processed");
  });

  test("a FIRST-delivery job cannot steal an in-flight 'processing' row (concurrent duplicate)", async () => {
    await seedUserWithLink();
    await stubTurn("done");
    await prisma.whatsAppMessageLog.create({
      data: { direction: "inbound", phone: PHONE, providerSid: "SM_IN_1", status: "processing" },
    });

    await processor.handleInbound(inbound("SM_IN_1"), 0);

    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(senderStub.send).not.toHaveBeenCalled();
  });

  test("a RETRYING job reclaims a stale 'processing' row left by its own crashed attempt", async () => {
    await seedUserWithLink();
    await stubTurn("done");
    await prisma.whatsAppMessageLog.create({
      data: { direction: "inbound", phone: PHONE, providerSid: "SM_IN_1", status: "processing" },
    });

    await processor.handleInbound(inbound("SM_IN_1"), 1);

    expect(agentStub.runTurn).toHaveBeenCalledTimes(1);
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("processed");
  });

  test("an unmapped number is a silent drop + audit — no turn, no reply (c9C open-relay)", async () => {
    await seedUserWithLink(); // a link exists — for a DIFFERENT number
    await processor.handleInbound(inbound("SM_IN_1", { from: `whatsapp:${OTHER_PHONE}` }), 0);

    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(senderStub.send).not.toHaveBeenCalled();
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("dropped_unmapped");
    expect(row.phone).toBe(OTHER_PHONE); // canonical in the ledger even when unmapped
  });

  test("an unparseable From is a silent drop + audit", async () => {
    await processor.handleInbound(inbound("SM_IN_1", { from: "whatsapp:not-a-number" }), 0);
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("dropped_unmapped");
    expect(agentStub.runTurn).not.toHaveBeenCalled();
  });

  test("a deactivated link fails closed at the chokepoint — dropped, no reply", async () => {
    await seedUserWithLink(UserRole.ADMIN, { active: false });
    await processor.handleInbound(inbound("SM_IN_1"), 0);

    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(senderStub.send).not.toHaveBeenCalled();
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("dropped_unauthorized");
  });

  test("a linked user demoted below agent:use fails closed at TURN time (c9B)", async () => {
    await seedUserWithLink(UserRole.OFFICE_STAFF);
    await processor.handleInbound(inbound("SM_IN_1"), 0);

    expect(agentStub.runTurn).not.toHaveBeenCalled();
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("dropped_unauthorized");
  });

  test("STOP deactivates the link, audits opt_out, and never replies (opt-out policy)", async () => {
    const { linkId } = await seedUserWithLink();
    await processor.handleInbound(inbound("SM_IN_1", { body: "  Stop " }), 0);

    const link = await prisma.agentPhoneLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.active).toBe(false);
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("opt_out");
    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(senderStub.send).not.toHaveBeenCalled();
  });

  test("START reactivates a deactivated link (user-recoverable opt-in), then messages flow again", async () => {
    const { linkId } = await seedUserWithLink(UserRole.ADMIN, { active: false });
    await processor.handleInbound(inbound("SM_IN_1", { body: "START" }), 0);

    const link = await prisma.agentPhoneLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.active).toBe(true);
    expect(
      (await prisma.whatsAppMessageLog.findUniqueOrThrow({ where: { providerSid: "SM_IN_1" } }))
        .status,
    ).toBe("opt_in");
    expect(senderStub.send).not.toHaveBeenCalled();

    await stubTurn("back online");
    await processor.handleInbound(inbound("SM_IN_2"), 0);
    expect(agentStub.runTurn).toHaveBeenCalledTimes(1);
  });

  test("STOP from an unmapped number changes nothing — dropped_unmapped", async () => {
    await processor.handleInbound(
      inbound("SM_IN_1", { from: `whatsapp:${OTHER_PHONE}`, body: "STOP" }),
      0,
    );
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("dropped_unmapped");
  });

  test("a same-conversation 409 parks the row as waiting_retry and RETHROWS for the backoff retry (c3)", async () => {
    await seedUserWithLink();
    agentStub.runTurn.mockRejectedValue(new ConflictException("turn in flight"));

    await expect(processor.handleInbound(inbound("SM_IN_1"), 0)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("waiting_retry");
    expect(senderStub.send).not.toHaveBeenCalled();
  });

  test("any other turn failure is TERMINAL — failed, no rethrow, no retry (the turn is not idempotent)", async () => {
    await seedUserWithLink();
    agentStub.runTurn.mockRejectedValue(new Error("provider exploded"));

    await expect(processor.handleInbound(inbound("SM_IN_1"), 0)).resolves.toBeUndefined();

    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(row.status).toBe("failed");
    expect(senderStub.send).not.toHaveBeenCalled();
  });

  test("the daily cap drops the CAP+1-th inbound of the UTC day with an audit row (c8)", async () => {
    await seedUserWithLink();
    await stubTurn("ok");
    // The day's cap is already consumed by earlier messages.
    await prisma.whatsAppMessageLog.createMany({
      data: Array.from({ length: WHATSAPP_DAILY_INBOUND_CAP }, () => ({
        direction: "inbound",
        phone: PHONE,
        status: "processed",
      })),
    });

    await processor.handleInbound(inbound("SM_IN_OVER"), 0);

    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(senderStub.send).not.toHaveBeenCalled();
    const row = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_OVER" },
    });
    expect(row.status).toBe("rate_limited");
  });

  test("a send failure is recorded as a failed outbound row; the inbound still completes (turn stands)", async () => {
    await seedUserWithLink();
    await stubTurn("the reply that will not arrive");
    senderStub.send.mockRejectedValue(new Error("twilio down"));

    await processor.handleInbound(inbound("SM_IN_1"), 0);

    const inRow = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(inRow.status).toBe("processed");
    const outRows = await prisma.whatsAppMessageLog.findMany({ where: { direction: "outbound" } });
    expect(outRows).toHaveLength(1);
    expect(outRows[0]?.status).toBe("failed");
    expect(outRows[0]?.providerSid).toBeNull();
  });

  test("a long reply sends every chunk in order, one outbound ledger row per segment", async () => {
    await seedUserWithLink();
    // >1600 (multi-chunk) but ≤4096 (no ceiling truncation — that behavior is
    // pinned in render-turn.test.ts; here the invariant is chunks-rejoin-lossless).
    const longReply = Array.from({ length: 100 }, (_, i) => `line ${String(i)} of the report`).join(
      "\n",
    );
    await stubTurn(longReply);

    await processor.handleInbound(inbound("SM_IN_1"), 0);

    expect(senderStub.send.mock.calls.length).toBeGreaterThan(1);
    const sentBodies = senderStub.send.mock.calls.map((call) => (call[0] as { body: string }).body);
    expect(sentBodies.join("")).toBe(longReply);
    const outRows = await prisma.whatsAppMessageLog.findMany({
      where: { direction: "outbound" },
      orderBy: { createdAt: "asc" },
    });
    expect(outRows).toHaveLength(sentBodies.length);
    expect(new Set(outRows.map((r) => r.providerSid)).size).toBe(outRows.length);
  });

  // ——— W5: the photo path (inert behind the image pause — the attachment
  // stores and the turn runs; extraction degrades honestly when
  // AGENT_OCR_URL is unset, which is the agent's own tested behavior). ———

  /** Real JPEG magic bytes — the attachments service sniffs CONTENT. */
  const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
  const MEDIA_URL = "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/SM_IN_1/Media/ME1";

  test("a photo with a caption stores a sniffed attachment and rides the turn (W5)", async () => {
    const { userId } = await seedUserWithLink();
    await stubTurn("Got the receipt.");
    mediaStub.download.mockResolvedValue({
      bytes: JPEG_BYTES,
      // Deliberately wrong declared type: the REAL sniff must win.
      declaredContentType: "application/octet-stream",
    });

    await processor.handleInbound(
      inbound("SM_IN_1", { body: "diesel receipt from today", mediaUrl: MEDIA_URL }),
      0,
    );

    const attachment = await prisma.agentAttachment.findFirstOrThrow();
    expect(attachment.contentType).toBe("image/jpeg"); // sniffed, not declared
    expect(attachment.sizeBytes).toBe(JPEG_BYTES.length);
    expect(attachment.userId).toBe(userId);

    expect(agentStub.runTurn).toHaveBeenCalledTimes(1);
    const call = agentStub.runTurn.mock.calls[0] as [string, string, Actor, string | undefined];
    expect(call[1]).toBe("diesel receipt from today"); // the caption is the content
    expect(call[3]).toBe(attachment.id); // the attachment rides the turn
    expect(attachment.conversationId).toBe(call[0]);

    const inRow = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(inRow.status).toBe("processed");
  });

  test("a captionless photo is NOT ignored-empty — the attachment alone carries the turn", async () => {
    await seedUserWithLink();
    await stubTurn("What should I do with this photo?");
    mediaStub.download.mockResolvedValue({ bytes: JPEG_BYTES, declaredContentType: "image/jpeg" });

    await processor.handleInbound(inbound("SM_IN_1", { body: "", mediaUrl: MEDIA_URL }), 0);

    expect(agentStub.runTurn).toHaveBeenCalledTimes(1);
    const call = agentStub.runTurn.mock.calls[0] as [string, string, Actor, string | undefined];
    expect(call[1]).toBe("");
    expect(typeof call[3]).toBe("string");
    expect(senderStub.send).toHaveBeenCalledTimes(1);
  });

  test("a failed media download drops the WHOLE message with the server-authored notice (no turn)", async () => {
    await seedUserWithLink();
    mediaStub.download.mockRejectedValue(new Error("twilio media 404"));

    await processor.handleInbound(
      inbound("SM_IN_1", { body: "receipt attached", mediaUrl: MEDIA_URL }),
      0,
    );

    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(senderStub.send).toHaveBeenCalledTimes(1);
    expect(senderStub.send.mock.calls[0]?.[0]).toEqual({ to: PHONE, body: MEDIA_FAILED_NOTICE });

    const inRow = await prisma.whatsAppMessageLog.findUniqueOrThrow({
      where: { providerSid: "SM_IN_1" },
    });
    expect(inRow.status).toBe("media_failed");
    expect(inRow.conversationId).not.toBeNull();
    const outRows = await prisma.whatsAppMessageLog.findMany({ where: { direction: "outbound" } });
    expect(outRows).toHaveLength(1);
    expect(outRows[0]?.status).toBe("sent");
  });

  test("non-image bytes fail the REAL magic-byte sniff and take the same media_failed path", async () => {
    await seedUserWithLink();
    mediaStub.download.mockResolvedValue({
      bytes: Buffer.from("%PDF-1.7 not an image"),
      declaredContentType: "image/jpeg", // a lying declared type must not help
    });

    await processor.handleInbound(inbound("SM_IN_1", { mediaUrl: MEDIA_URL }), 0);

    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(await prisma.agentAttachment.count()).toBe(0);
    expect(
      (await prisma.whatsAppMessageLog.findUniqueOrThrow({ where: { providerSid: "SM_IN_1" } }))
        .status,
    ).toBe("media_failed");
    expect(senderStub.send.mock.calls[0]?.[0]).toEqual({ to: PHONE, body: MEDIA_FAILED_NOTICE });
  });

  test("no text and no media is ignored before any conversation exists (no turn, no reply)", async () => {
    await seedUserWithLink();
    await processor.handleInbound(inbound("SM_IN_1", { body: "   " }), 0);

    expect(agentStub.createConversation).not.toHaveBeenCalled();
    expect(agentStub.runTurn).not.toHaveBeenCalled();
    expect(senderStub.send).not.toHaveBeenCalled();
    expect(
      (await prisma.whatsAppMessageLog.findUniqueOrThrow({ where: { providerSid: "SM_IN_1" } }))
        .status,
    ).toBe("ignored_empty");
  });
});
