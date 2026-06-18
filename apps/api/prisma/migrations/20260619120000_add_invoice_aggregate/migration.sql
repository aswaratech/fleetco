-- Invoice aggregate (Program D / ADR-0039 commitment 1): FleetCo's FIRST
-- revenue-side aggregate. A dedicated TWO-table pair —
--   * invoice       (the header: required customer + nullable job, the
--                     DRAFT/ISSUED/CANCELLED status, the INVOICE/CREDIT_NOTE
--                     discriminator + the nullable self-FK a credit note uses to
--                     reference its original, the nullable-until-issue frozen-tax
--                     columns + the unique fiscal-year number, issuedAt, the R2
--                     PDF key, and the createdById audit anchor), and
--   * invoice_line  (the owned billable lines: required invoice FK + nullable
--                     trip/job provenance FKs + the captured selling amount).
--
-- D1 lands ONLY the schema + this migration + a READ skeleton. The TAX MATH (D2),
-- the gapless numbering + DRAFT->ISSUED lifecycle (D3), the build-from-trips line
-- assembly (D4), the PDF/R2 storage (D5), and the web surface (D6) layer on later
-- tickets — which is why every frozen-tax column + `number` + `issuedAt` +
-- `pdfR2Key` are NULLABLE here (filled at issue, never on a DRAFT).
--
-- FK delete policy (ADR-0039 c1) — the house Restrict posture everywhere EXCEPT
-- the one true parent-child edge:
--   * invoice.customerId           -> customer  ON DELETE RESTRICT  (required)
--   * invoice.jobId                -> job       ON DELETE RESTRICT  (nullable)
--   * invoice.originalInvoiceId    -> invoice   ON DELETE RESTRICT  (nullable self-FK)
--   * invoice.createdById          -> user      ON DELETE RESTRICT  (audit anchor)
--   * invoice_line.invoiceId       -> invoice   ON DELETE CASCADE   (a line is OWNED
--                                    by its invoice — deleting a DRAFT deletes its
--                                    lines; an ISSUED invoice is immutable + never
--                                    deleted, D3)
--   * invoice_line.tripId          -> trip      ON DELETE RESTRICT  (nullable provenance)
--   * invoice_line.jobId           -> job       ON DELETE RESTRICT  (nullable provenance)
-- The existing CustomersService.delete P2003 -> 409 arm (and a future JobsService
-- one) covers the new customer/job referencers with NO service change.
--
-- The two new tables are the ONLY schema additions; customer/job/trip/user gain
-- ONLY the Prisma back-relation field (a model edit, no data migration on
-- existing rows), exactly the ADR-0037 cost-link posture.
--
-- HAND-AUTHORED per the kickoff — `prisma migrate dev` AND `--create-only` are
-- non-interactive-blocked in this env (they want a TTY). The canonical Prisma SQL
-- below was generated via `prisma migrate diff --from-schema-datasource
-- prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`; the
-- SIX PRE-EXISTING drift steps that diff always emits are deliberately EXCLUDED so
-- this migration touches ONLY the two new tables:
--   * the FOUR ADR-0029/0030 PostGIS generated-column steps (DROP INDEX
--     geofence_geometry_idx / gps_ping_geometry_idx + ALTER ... geometry DROP
--     DEFAULT on geofence / gps_ping — the accepted hybrid cost), and
--   * TWO pre-existing notification_log steps from Program C (ALTER ... sentAt
--     DROP NOT NULL + CREATE INDEX notification_log_createdAt_idx) — an existing
--     schema/migration mismatch, NOT introduced here and NOT this slice's to fix.
-- A post-apply `migrate diff ... --exit-code` shows ONLY those six pre-existing
-- steps and NOT invoice / invoice_line — the D1 verification.

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "document_type" AS ENUM ('INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "invoice_service_type" AS ENUM ('VEHICLE_HIRE', 'GOODS_TRANSPORT');

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "documentType" "document_type" NOT NULL DEFAULT 'INVOICE',
    "originalInvoiceId" TEXT,
    "number" TEXT,
    "subtotalPaisa" INTEGER,
    "discountPaisa" INTEGER,
    "vatRateBp" INTEGER,
    "vatPaisa" INTEGER,
    "grossPaisa" INTEGER,
    "tdsRateBp" INTEGER,
    "tdsPaisa" INTEGER,
    "netReceivablePaisa" INTEGER,
    "serviceType" "invoice_service_type",
    "issuedAt" TIMESTAMP(3),
    "pdfR2Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "tripId" TEXT,
    "jobId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPricePaisa" INTEGER NOT NULL,
    "lineAmountPaisa" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_number_key" ON "invoice"("number");

-- CreateIndex
CREATE INDEX "invoice_customerId_idx" ON "invoice"("customerId");

-- CreateIndex
CREATE INDEX "invoice_jobId_idx" ON "invoice"("jobId");

-- CreateIndex
CREATE INDEX "invoice_status_idx" ON "invoice"("status");

-- CreateIndex
CREATE INDEX "invoice_documentType_idx" ON "invoice"("documentType");

-- CreateIndex
CREATE INDEX "invoice_originalInvoiceId_idx" ON "invoice"("originalInvoiceId");

-- CreateIndex
CREATE INDEX "invoice_createdById_idx" ON "invoice"("createdById");

-- CreateIndex
CREATE INDEX "invoice_createdAt_idx" ON "invoice"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "invoice_line_invoiceId_idx" ON "invoice_line"("invoiceId");

-- CreateIndex
CREATE INDEX "invoice_line_tripId_idx" ON "invoice_line"("tripId");

-- CreateIndex
CREATE INDEX "invoice_line_jobId_idx" ON "invoice_line"("jobId");

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_originalInvoiceId_fkey" FOREIGN KEY ("originalInvoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
