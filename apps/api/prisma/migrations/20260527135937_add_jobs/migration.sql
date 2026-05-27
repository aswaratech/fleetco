-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL,
    "jobNumber" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'PLANNED',
    "scheduledStartDate" TIMESTAMP(3),
    "scheduledEndDate" TIMESTAMP(3),
    "actualStartDate" TIMESTAMP(3),
    "actualEndDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_jobNumber_key" ON "job"("jobNumber");

-- CreateIndex
CREATE INDEX "job_customerId_idx" ON "job"("customerId");

-- CreateIndex
CREATE INDEX "job_status_idx" ON "job"("status");

-- CreateIndex
CREATE INDEX "job_createdAt_idx" ON "job"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "job_createdById_idx" ON "job"("createdById");

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
