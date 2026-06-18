-- Notification/reminder-delivery dedup ledger + audit trail (ADR-0038 C2,
-- commitment 5): the NotificationLog records every reminder the daily scan
-- dispatches, keyed by (subjectType, subjectId, reminderKind, state,
-- occurrenceKey) so a lapse is emailed ONCE per state per occurrence (a renewal
-- to a new expiry = a new occurrenceKey, which re-arms). Tier 3 per ADR-0013.
-- Hand-authored per the kickoff — `prisma migrate dev` / `--create-only` are
-- non-interactive-blocked in this env. The canonical Prisma SQL was generated
-- via `prisma migrate diff --to-schema-datamodel --script`; the four PRE-EXISTING
-- PostGIS drift steps that diff always emits (DROP INDEX geofence_geometry_idx /
-- gps_ping_geometry_idx + ALTER ... geometry DROP DEFAULT — the accepted
-- ADR-0029/0030 generated-column hybrid cost) are deliberately EXCLUDED so this
-- migration touches only the one new table.
--
-- The dedup-key fields (subjectType / reminderKind / state) are TEXT, not enums,
-- so the C3 maintenance source extends them with new values (SERVICE_SCHEDULE,
-- the service kinds, due-soon/overdue) WITHOUT a migration, and `state` stores
-- the shared @fleetco/shared classifier's literal with no enum-mapping drift
-- (ADR-0038 c6). No createdById FK: a scan is a background job, not a user
-- action.

-- CreateTable
CREATE TABLE "notification_log" (
    "id" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "reminderKind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_log_subjectType_subjectId_idx" ON "notification_log"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "notification_log_createdAt_idx" ON "notification_log"("createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notification_log_subjectType_subjectId_reminderKind_state_o_key" ON "notification_log"("subjectType", "subjectId", "reminderKind", "state", "occurrenceKey");
