-- Hand-authored (ADR-0049 F3): local `prisma migrate dev` is blocked in this
-- non-interactive environment, so this migration is written by hand and
-- verified with `prisma migrate diff --exit-code` (only the four accepted
-- PostGIS generated-column steps remain). Pure additive DDL: the RenewalKind
-- enum + the renewal_record table (vehicle FK required; document/expense
-- links nullable, all RESTRICT — a referenced proof or cost row
-- delete-blocks through the house P2003 -> 409 arms).

-- CreateEnum
CREATE TYPE "renewal_kind" AS ENUM ('BLUEBOOK', 'INSURANCE', 'ROUTE_PERMIT');

-- CreateTable
CREATE TABLE "renewal_record" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "kind" "renewal_kind" NOT NULL,
    "previousExpiresAt" TIMESTAMP(3),
    "newExpiresAt" TIMESTAMP(3) NOT NULL,
    "renewedAt" TIMESTAMP(3) NOT NULL,
    "documentId" TEXT,
    "expenseLogId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "renewal_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "renewal_record_vehicleId_idx" ON "renewal_record"("vehicleId");

-- CreateIndex
CREATE INDEX "renewal_record_renewedAt_idx" ON "renewal_record"("renewedAt" DESC);

-- CreateIndex
CREATE INDEX "renewal_record_documentId_idx" ON "renewal_record"("documentId");

-- CreateIndex
CREATE INDEX "renewal_record_expenseLogId_idx" ON "renewal_record"("expenseLogId");

-- CreateIndex
CREATE INDEX "renewal_record_createdById_idx" ON "renewal_record"("createdById");

-- AddForeignKey
ALTER TABLE "renewal_record" ADD CONSTRAINT "renewal_record_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_record" ADD CONSTRAINT "renewal_record_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "fleet_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_record" ADD CONSTRAINT "renewal_record_expenseLogId_fkey" FOREIGN KEY ("expenseLogId") REFERENCES "expense_log"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_record" ADD CONSTRAINT "renewal_record_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
