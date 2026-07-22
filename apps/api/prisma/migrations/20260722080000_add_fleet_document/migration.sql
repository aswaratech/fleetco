-- Hand-authored (ADR-0049 F2): local `prisma migrate dev` is blocked in this
-- non-interactive environment, so this migration is written by hand and
-- verified with `prisma migrate diff --exit-code` (which must show ONLY the
-- four pre-existing PostGIS generated-column steps). Pure additive DDL: the
-- DocumentCategory enum + the fleet_document table with three nullable
-- RESTRICT entity FKs (exactly-one enforced at the service layer — the
-- recorded no-DB-CHECK decision).

-- CreateEnum
CREATE TYPE "document_category" AS ENUM ('BLUEBOOK', 'INSURANCE', 'ROUTE_PERMIT', 'AGREEMENT', 'LICENSE', 'ID_DOCUMENT', 'OTHER');

-- CreateTable
CREATE TABLE "fleet_document" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "customerId" TEXT,
    "category" "document_category" NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "expiresAt" TIMESTAMP(3),
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "fleet_document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleet_document_r2Key_key" ON "fleet_document"("r2Key");

-- CreateIndex
CREATE INDEX "fleet_document_vehicleId_idx" ON "fleet_document"("vehicleId");

-- CreateIndex
CREATE INDEX "fleet_document_driverId_idx" ON "fleet_document"("driverId");

-- CreateIndex
CREATE INDEX "fleet_document_customerId_idx" ON "fleet_document"("customerId");

-- CreateIndex
CREATE INDEX "fleet_document_expiresAt_idx" ON "fleet_document"("expiresAt");

-- CreateIndex
CREATE INDEX "fleet_document_createdById_idx" ON "fleet_document"("createdById");

-- AddForeignKey
ALTER TABLE "fleet_document" ADD CONSTRAINT "fleet_document_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_document" ADD CONSTRAINT "fleet_document_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_document" ADD CONSTRAINT "fleet_document_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet_document" ADD CONSTRAINT "fleet_document_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
