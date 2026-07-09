-- AgentPhoneLink + WhatsAppMessageLog — the WhatsApp channel's per-user phone→user
-- identity map (ADR-0046 c4) and its inbound/outbound delivery + idempotency
-- ledger (ADR-0046 c7), ticket W2.
--
-- Hand-authored from the generated diff (the local env blocks `prisma migrate
-- dev`; the house pattern since D1): produced with `prisma migrate diff
-- --from-schema-datasource prisma/schema.prisma --to-schema-datamodel
-- prisma/schema.prisma --script`, applied with `prisma migrate deploy`, and
-- verified drift-free with the same diff `--exit-code` afterward — which then
-- shows ONLY the FOUR pre-existing ADR-0029/0030 PostGIS generated-column steps
-- (DROP INDEX gps_ping_geometry_idx / geofence_geometry_idx + ALTER … geometry
-- DROP DEFAULT on gps_ping / geofence — the accepted hybrid cost), deliberately
-- EXCLUDED here so this migration touches ONLY the two new WhatsApp tables.
--
-- Two shapes, both reused (ADR-0046 — composition, not invention). agent_phone_link
-- is the identity map: phoneE164 is @unique (the exact-match security key,
-- c4/c9), userId FKs into user ON DELETE RESTRICT (the universal audit-actor
-- posture — the linked human cannot be deleted out from under the mapping), and
-- conversationId FKs into agent_conversation ON DELETE SET NULL so the 180-day
-- transcript prune detaches the stable-conversation pointer rather than blocking
-- or deleting the link. whatsapp_message_log is the delivery/idempotency ledger
-- (the notification_log shape): providerSid is @unique — the load-bearing replay
-- defense (c7), nullable-until-sent for outbound so pending rows coexist — and
-- its conversation/message FKs are ON DELETE SET NULL so the wire-facts ledger
-- survives the transcript prune (the agent_action posture). No userId FK here:
-- attribution to the human is the resolved actor on the AgentAction rows a turn
-- writes, not this wire log.

-- CreateTable
CREATE TABLE "agent_phone_link" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_phone_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_message_log" (
    "id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "providerSid" TEXT,
    "status" TEXT NOT NULL,
    "conversationId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_message_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_phone_link_phoneE164_key" ON "agent_phone_link"("phoneE164");

-- CreateIndex
CREATE INDEX "agent_phone_link_userId_idx" ON "agent_phone_link"("userId");

-- CreateIndex
CREATE INDEX "agent_phone_link_conversationId_idx" ON "agent_phone_link"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_message_log_providerSid_key" ON "whatsapp_message_log"("providerSid");

-- CreateIndex
CREATE INDEX "whatsapp_message_log_conversationId_idx" ON "whatsapp_message_log"("conversationId");

-- CreateIndex
CREATE INDEX "whatsapp_message_log_messageId_idx" ON "whatsapp_message_log"("messageId");

-- AddForeignKey
ALTER TABLE "agent_phone_link" ADD CONSTRAINT "agent_phone_link_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_phone_link" ADD CONSTRAINT "agent_phone_link_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_message_log" ADD CONSTRAINT "whatsapp_message_log_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_message_log" ADD CONSTRAINT "whatsapp_message_log_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "agent_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
