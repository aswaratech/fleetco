-- CreateEnum
CREATE TYPE "insurance_type" AS ENUM ('THIRD_PARTY', 'COMPREHENSIVE');

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN     "bluebookExpiresAt" TIMESTAMP(3),
ADD COLUMN     "bluebookNumber" TEXT,
ADD COLUMN     "insuranceExpiresAt" TIMESTAMP(3),
ADD COLUMN     "insurancePolicyNumber" TEXT,
ADD COLUMN     "insuranceType" "insurance_type",
ADD COLUMN     "insurer" TEXT,
ADD COLUMN     "routePermitExpiresAt" TIMESTAMP(3),
ADD COLUMN     "routePermitNumber" TEXT;
