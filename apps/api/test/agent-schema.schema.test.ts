import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import {
  seedAgentAction,
  seedAgentConversation,
  seedAgentMessage,
} from "./fixtures/agent-transcript";
import { seedUser } from "./fixtures/trip";

// Schema-rails test for the AI agent's persistence + audit spine (ADR-0043
// commitment 5, ticket A2), on the tracker-device.schema.test.ts pattern:
// behavior is asserted against the REAL database (round-trips, Prisma error
// codes, pg_indexes) — not by parsing schema text — so a hand-authored
// migration that silently diverged from schema.prisma fails here.
//
// The load-bearing assertion is the TWO-LIFECYCLE SEAM: deleting a
// conversation CASCADEs its messages (transcript rows die together) but
// SETS NULL on its actions (audit rows are detached, never deleted) — the
// schema's FIRST onDelete: SetNull, ratified explicitly by ADR-0043 c5 so the
// 180-day transcript prune can never touch the indefinite audit trail.

describe("Agent schema rails (ADR-0043 A2)", () => {
  let prisma: PrismaService;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    userId = await seedUser(prisma);
  });

  test("round-trips all three models with defaults and relations", async () => {
    const conversation = await seedAgentConversation(prisma, userId, {
      title: "Fuel report for Shrawan",
    });
    const message = await seedAgentMessage(prisma, conversation.id, {
      role: "assistant",
      content: "Here is the fuel report…",
      promptTokens: 1200,
      completionTokens: 340,
    });
    const action = await seedAgentAction(prisma, userId, {
      conversationId: conversation.id,
      messageId: message.id,
      toolName: "report_per_vehicle_cost",
      argsJson: { from: "2026-06-01", to: "2026-06-30" },
      status: "succeeded",
      latencyMs: 180,
    });

    const found = await prisma.agentAction.findUniqueOrThrow({
      where: { id: action.id },
      include: { conversation: true, message: true, user: true },
    });
    expect(found.conversation?.id).toBe(conversation.id);
    expect(found.message?.content).toBe("Here is the fuel report…");
    expect(found.user.id).toBe(userId);
    expect(found.previousJson).toBeNull();
    expect(found.resultEntityType).toBeNull();

    const foundMessage = await prisma.agentMessage.findUniqueOrThrow({
      where: { id: message.id },
      include: { conversation: true },
    });
    expect(foundMessage.conversation.title).toBe("Fuel report for Shrawan");
    expect(foundMessage.promptTokens).toBe(1200);
    expect(foundMessage.completionTokens).toBe(340);
  });

  test("deleting a conversation CASCADEs its messages (owned transcript children)", async () => {
    const conversation = await seedAgentConversation(prisma, userId);
    await seedAgentMessage(prisma, conversation.id);
    await seedAgentMessage(prisma, conversation.id, { role: "assistant" });

    await prisma.agentConversation.delete({ where: { id: conversation.id } });

    expect(await prisma.agentMessage.count()).toBe(0);
  });

  test("deleting a conversation SETS NULL on its actions — the audit row stands with its denormalized context", async () => {
    const conversation = await seedAgentConversation(prisma, userId);
    const message = await seedAgentMessage(prisma, conversation.id, { role: "assistant" });
    const action = await seedAgentAction(prisma, userId, {
      conversationId: conversation.id,
      messageId: message.id,
      toolName: "update_vehicle",
      argsJson: { id: "veh_1", status: "IN_MAINTENANCE" },
      resultEntityType: "Vehicle",
      resultEntityId: "veh_1",
      previousJson: { status: "ACTIVE" },
      status: "succeeded",
      latencyMs: 95,
    });

    // The transcript prune's delete: conversation + (via CASCADE) message go.
    await prisma.agentConversation.delete({ where: { id: conversation.id } });

    const survivor = await prisma.agentAction.findUniqueOrThrow({ where: { id: action.id } });
    // Detached from the pruned transcript…
    expect(survivor.conversationId).toBeNull();
    expect(survivor.messageId).toBeNull();
    // …but the standalone audit context is intact (ADR-0043 c5).
    expect(survivor.toolName).toBe("update_vehicle");
    expect(survivor.userId).toBe(userId);
    expect(survivor.resultEntityType).toBe("Vehicle");
    expect(survivor.resultEntityId).toBe("veh_1");
    expect(survivor.previousJson).toEqual({ status: "ACTIVE" });
    expect(survivor.status).toBe("succeeded");
  });

  test("deleting just a message SETS NULL on messageId while conversationId survives", async () => {
    const conversation = await seedAgentConversation(prisma, userId);
    const message = await seedAgentMessage(prisma, conversation.id, { role: "assistant" });
    const action = await seedAgentAction(prisma, userId, {
      conversationId: conversation.id,
      messageId: message.id,
    });

    await prisma.agentMessage.delete({ where: { id: message.id } });

    const survivor = await prisma.agentAction.findUniqueOrThrow({ where: { id: action.id } });
    expect(survivor.messageId).toBeNull();
    expect(survivor.conversationId).toBe(conversation.id);
  });

  test("the user FKs are RESTRICT: a user with agent rows cannot be deleted (P2003)", async () => {
    const conversation = await seedAgentConversation(prisma, userId);
    await seedAgentAction(prisma, userId, { conversationId: conversation.id });

    await expect(prisma.user.delete({ where: { id: userId } })).rejects.toMatchObject({
      code: "P2003",
    });
    // Both rows survive the blocked delete.
    expect(await prisma.agentConversation.count()).toBe(1);
    expect(await prisma.agentAction.count()).toBe(1);
  });

  test("the hand-authored migration's indexes physically exist", async () => {
    // The pg_indexes assertion that catches a hand-authored migration silently
    // diverging from schema.prisma (the gps_ping precedent in
    // tracker-device.schema.test.ts).
    const indexes = await prisma.$queryRaw<{ tablename: string; indexname: string }[]>(
      Prisma.sql`SELECT tablename, indexname FROM pg_indexes
                 WHERE tablename IN ('agent_conversation', 'agent_message', 'agent_action')`,
    );
    const names = indexes.map((row) => row.indexname);
    expect(names).toContain("agent_conversation_userId_idx");
    expect(names).toContain("agent_conversation_updatedAt_idx");
    expect(names).toContain("agent_message_conversationId_idx");
    expect(names).toContain("agent_action_userId_idx");
    expect(names).toContain("agent_action_createdAt_idx");
    expect(names).toContain("agent_action_toolName_idx");
    expect(names).toContain("agent_action_conversationId_idx");
    expect(names).toContain("agent_action_messageId_idx");
  });
});
