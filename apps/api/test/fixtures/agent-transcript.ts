import { randomUUID } from "node:crypto";

import {
  type AgentAction,
  type AgentConversation,
  type AgentMessage,
  type PrismaClient,
} from "@prisma/client";

// Seed helpers for the AI agent's persistence + audit spine (ADR-0043 c5,
// ticket A2): AgentConversation / AgentMessage / AgentAction rows for the
// schema rails test and the transcript-prune boundary/worker tests. Mirrors
// the fixtures/trip.ts style: unique-per-call values, sensible defaults,
// overrides for what a specific test pins. (Named agent-transcript.ts — the
// sibling A4 ticket owns fixtures/agent.ts for the tool-registry seeds.)

/**
 * Create an AgentConversation. `updatedAt` is overridable because it is the
 * transcript prune's retention basis: Prisma honors an explicitly provided
 * value for an @updatedAt field on create, so prune tests can seed
 * conversations on both sides of the cutoff deterministically.
 */
export async function seedAgentConversation(
  prisma: PrismaClient,
  userId: string,
  overrides: Partial<Omit<AgentConversation, "id" | "userId">> = {},
): Promise<AgentConversation> {
  return prisma.agentConversation.create({
    data: {
      userId,
      title:
        "title" in overrides ? overrides.title : `Test conversation ${randomUUID().slice(0, 8)}`,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    },
  });
}

export async function seedAgentMessage(
  prisma: PrismaClient,
  conversationId: string,
  overrides: Partial<Omit<AgentMessage, "id" | "conversationId">> = {},
): Promise<AgentMessage> {
  return prisma.agentMessage.create({
    data: {
      conversationId,
      role: overrides.role ?? "user",
      content: overrides.content ?? `Test message ${randomUUID().slice(0, 8)}`,
      promptTokens: overrides.promptTokens ?? null,
      completionTokens: overrides.completionTokens ?? null,
    },
  });
}

export async function seedAgentAction(
  prisma: PrismaClient,
  userId: string,
  overrides: Partial<Omit<AgentAction, "id" | "userId">> = {},
): Promise<AgentAction> {
  return prisma.agentAction.create({
    data: {
      userId,
      conversationId: overrides.conversationId ?? null,
      messageId: overrides.messageId ?? null,
      toolName: overrides.toolName ?? "list_vehicles",
      argsJson: overrides.argsJson ?? { take: 5 },
      resultEntityType: overrides.resultEntityType ?? null,
      resultEntityId: overrides.resultEntityId ?? null,
      previousJson: overrides.previousJson ?? undefined,
      status: overrides.status ?? "succeeded",
      latencyMs: overrides.latencyMs ?? 42,
      // Overridable so the A8 activity-ledger date-range tests can seed rows
      // on both sides of a cutoff deterministically (Prisma honors an
      // explicit @default value on create, like the conversation helper).
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}
