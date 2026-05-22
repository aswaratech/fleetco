-- CreateEnum
CREATE TYPE "vehicle_kind" AS ENUM ('TRUCK', 'TIPPER', 'EXCAVATOR', 'LOADER', 'GRADER', 'OTHER');

-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('ACTIVE', 'IN_MAINTENANCE', 'RETIRED', 'SOLD');

-- CreateTable
CREATE TABLE "vehicle" (
    "id" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "kind" "vehicle_kind" NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" "vehicle_status" NOT NULL DEFAULT 'ACTIVE',
    "odometerStartKm" INTEGER NOT NULL DEFAULT 0,
    "odometerCurrentKm" INTEGER NOT NULL DEFAULT 0,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_registrationNumber_key" ON "vehicle"("registrationNumber");

-- CreateIndex
CREATE INDEX "vehicle_status_idx" ON "vehicle"("status");

-- CreateIndex
CREATE INDEX "vehicle_kind_idx" ON "vehicle"("kind");

-- CreateIndex
CREATE INDEX "vehicle_createdById_idx" ON "vehicle"("createdById");

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
