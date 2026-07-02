-- AgentConversation + AgentMessage + AgentAction — the AI agent's persistence
-- + audit spine (ADR-0043 commitment 5, ticket A2).
--
-- Hand-authored (the local env blocks `prisma migrate dev`; the house pattern
-- since D1): generated with `prisma migrate diff --from-schema-datasource
-- prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`,
-- applied with `prisma migrate deploy`, and verified drift-free with the same
-- diff `--exit-code` afterward — which then shows ONLY the FOUR pre-existing
-- ADR-0029/0030 PostGIS generated-column steps (DROP INDEX
-- geofence_geometry_idx / gps_ping_geometry_idx + ALTER ... geometry DROP
-- DEFAULT on geofence / gps_ping — the accepted hybrid cost), deliberately
-- EXCLUDED here so this migration touches ONLY the three new agent tables.
-- (The two notification_log drift steps earlier migrations noted have since
-- been resolved; the PostGIS four are the only remaining expected drift.)
--
-- Two lifecycles, one seam (ADR-0043 c5): agent_conversation + agent_message
-- are the TRANSCRIPT, pruned at 180 days by the transcript-prune retention
-- job (a message CASCADEs with its conversation — the invoice_line pattern);
-- agent_action is the AUDIT TRAIL, kept indefinitely. agent_action's two
-- transcript FKs are therefore ON DELETE SET NULL — the FIRST SetNull in this
-- schema, ratified explicitly by ADR-0043 c5 — so the prune DETACHES audit
-- rows rather than deleting or blocking; the action row carries denormalized
-- standalone context (toolName, entity, userId, createdAt) for after its
-- transcript is gone. The userId FKs stay ON DELETE RESTRICT (the universal
-- audit-actor posture).

-- CreateTable
CREATE TABLE "agent_conversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_action" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "toolName" TEXT NOT NULL,
    "argsJson" JSONB NOT NULL,
    "resultEntityType" TEXT,
    "resultEntityId" TEXT,
    "previousJson" JSONB,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_action_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_conversation_userId_idx" ON "agent_conversation"("userId");

-- CreateIndex (the transcript prune's `updatedAt < cutoff` scan)
CREATE INDEX "agent_conversation_updatedAt_idx" ON "agent_conversation"("updatedAt");

-- CreateIndex
CREATE INDEX "agent_message_conversationId_idx" ON "agent_message"("conversationId");

-- CreateIndex
CREATE INDEX "agent_action_userId_idx" ON "agent_action"("userId");

-- CreateIndex (A8 activity page: most recent first)
CREATE INDEX "agent_action_createdAt_idx" ON "agent_action"("createdAt" DESC);

-- CreateIndex (A8 activity page: by-tool filter)
CREATE INDEX "agent_action_toolName_idx" ON "agent_action"("toolName");

-- CreateIndex (FK indexes so the prune's SET NULL fan-out never seq-scans)
CREATE INDEX "agent_action_conversationId_idx" ON "agent_action"("conversationId");

-- CreateIndex
CREATE INDEX "agent_action_messageId_idx" ON "agent_action"("messageId");

-- AddForeignKey
ALTER TABLE "agent_conversation" ADD CONSTRAINT "agent_conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_message" ADD CONSTRAINT "agent_message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_action" ADD CONSTRAINT "agent_action_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_action" ADD CONSTRAINT "agent_action_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "agent_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_action" ADD CONSTRAINT "agent_action_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
