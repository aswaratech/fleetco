-- CreateEnum
CREATE TYPE "license_class" AS ENUM ('LMV', 'HMV', 'HTV', 'HPMV');

-- CreateEnum
CREATE TYPE "driver_status" AS ENUM ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED');

-- CreateTable
CREATE TABLE "driver" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "licenseClass" "license_class" NOT NULL,
    "phone" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "hiredAt" TIMESTAMP(3) NOT NULL,
    "licenseExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" "driver_status" NOT NULL DEFAULT 'ACTIVE',
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "driver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_licenseNumber_key" ON "driver"("licenseNumber");

-- CreateIndex
CREATE INDEX "driver_status_idx" ON "driver"("status");

-- CreateIndex
CREATE INDEX "driver_licenseClass_idx" ON "driver"("licenseClass");

-- CreateIndex
CREATE INDEX "driver_createdById_idx" ON "driver"("createdById");

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
