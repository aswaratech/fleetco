-- Per-series gapless invoice-number counter (Program D / ADR-0039 commitment 4).
--
-- A DEDICATED counter table — deliberately NOT a Postgres SEQUENCE. A SEQUENCE
-- advances even on a ROLLED-BACK transaction, so a failed issue would burn a
-- number and leave a gap; an IRD anti-tamper invoice number must be gapless AND
-- never-reused (ADR-0039 c4 / Alternatives). This row advances ONLY when an
-- issue COMMITS: the issue $transaction reads it `SELECT … FOR UPDATE`,
-- increments it, and formats the number, so two concurrent issues serialize on
-- the row (no holes, no reuse) and a discarded DRAFT consumes no number (it has
-- none until issue). This HARDENS the JobsService.nextJobNumber precedent (which
-- leaves holes on delete and is keyed by the Gregorian year); it does not reuse it.
--
-- Keyed by (documentType, bsFiscalYear) — the composite PRIMARY KEY: an INVOICE
-- and a CREDIT_NOTE each get an INDEPENDENT gapless series (ADR-0039 c5), reset
-- per Nepali (Bikram Sambat) fiscal year (Shrawan→Ashadh, derived from the issue
-- date via the shared BS pipeline). The natural key IS the identity — no
-- surrogate id, no FKs (a standalone counter; nothing references it).
-- `document_type` is the enum the D1 migration (add_invoice_aggregate) created;
-- this migration only references it.
--
-- HAND-AUTHORED per the kickoff — `prisma migrate dev` AND `--create-only` are
-- non-interactive-blocked in this env (they want a TTY). The vitest global-setup
-- runs `prisma migrate deploy` against the test DB, so this migration applies on
-- `pnpm --filter @fleetco/api test`. Verified zero-drift afterward with
-- `prisma migrate diff --from-schema-datasource prisma/schema.prisma
-- --to-schema-datamodel prisma/schema.prisma --exit-code`, which then shows ONLY
-- the SIX pre-existing steps — the four ADR-0029/0030 PostGIS generated-column
-- steps (geofence / gps_ping) + the two Program-C notification_log steps — and
-- NOT invoice_number_sequence (the new table is fully captured by this migration).

-- CreateTable
CREATE TABLE "invoice_number_sequence" (
    "documentType" "document_type" NOT NULL,
    "bsFiscalYear" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_number_sequence_pkey" PRIMARY KEY ("documentType", "bsFiscalYear")
);
