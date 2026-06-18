-- B4 (ADR-0037 c6): the ServiceRecord → ExpenseLog cost link. A ServiceRecord
-- references the cost of a maintenance/repair service by a NULLABLE FK to an
-- existing ExpenseLog row (category MAINTENANCE/REPAIR) — it carries no
-- amountPaisa of its own. ExpenseLog itself is untouched (the Prisma
-- back-relation adds no column to expense_log); this migration adds only the
-- nullable column + its FK index + the FK constraint on service_record.
--
-- onDelete: RESTRICT (matching the schema) means a linked expense cannot be
-- deleted out from under a service record — ExpenseLogsService.delete maps the
-- resulting P2003 to HTTP 409 in this same slice.
--
-- Hand-authored per the kickoff (prisma migrate dev / --create-only are
-- non-interactive-blocked in this env). The canonical Prisma SQL was confirmed
-- via `prisma migrate diff --from-schema-datamodel --to-schema-datamodel
-- --script`; the four PRE-EXISTING PostGIS drift steps that diff always emits
-- (DROP INDEX geofence_geometry_idx / gps_ping_geometry_idx + ALTER ... geometry
-- DROP DEFAULT — the accepted ADR-0029/0030 generated-column hybrid cost) are
-- deliberately EXCLUDED so this migration touches only the new column + FK.

-- AlterTable
ALTER TABLE "service_record" ADD COLUMN "expenseLogId" TEXT;

-- CreateIndex
CREATE INDEX "service_record_expenseLogId_idx" ON "service_record"("expenseLogId");

-- AddForeignKey
ALTER TABLE "service_record" ADD CONSTRAINT "service_record_expenseLogId_fkey" FOREIGN KEY ("expenseLogId") REFERENCES "expense_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
