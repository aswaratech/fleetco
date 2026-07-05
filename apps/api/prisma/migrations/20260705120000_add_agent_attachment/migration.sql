-- AgentAttachment — the agent-chat attachment row (ADR-0044 c3, ticket V3).
--
-- Hand-authored (the local env blocks `prisma migrate dev`; the house pattern
-- since D1): verified with `prisma migrate diff --exit-code` afterward, which
-- then shows ONLY the four pre-existing ADR-0029/0030 PostGIS
-- generated-column steps (the accepted hybrid cost), deliberately EXCLUDED
-- here so this migration touches ONLY the new table.
--
-- Lifecycle (ADR-0044 c3): an attachment is TRANSCRIPT content — it cascades
-- with its agent_conversation under the 180-day transcript prune (which
-- deletes the stored object first, best-effort, then lets this FK cascade the
-- row). messageId is ON DELETE SET NULL (null = uploaded-but-unsent, pending
-- in the composer; set when a turn claims it). userId stays ON DELETE
-- RESTRICT — the universal audit-actor posture.

-- CreateTable
CREATE TABLE "agent_attachment" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "userId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_attachment_r2Key_key" ON "agent_attachment"("r2Key");

-- CreateIndex
CREATE INDEX "agent_attachment_conversationId_idx" ON "agent_attachment"("conversationId");

-- CreateIndex
CREATE INDEX "agent_attachment_messageId_idx" ON "agent_attachment"("messageId");

-- AddForeignKey
ALTER TABLE "agent_attachment" ADD CONSTRAINT "agent_attachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_attachment" ADD CONSTRAINT "agent_attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "agent_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_attachment" ADD CONSTRAINT "agent_attachment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
