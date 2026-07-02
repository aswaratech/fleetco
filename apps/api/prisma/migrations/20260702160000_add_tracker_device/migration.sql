-- TrackerDevice + hardware-ping riders (ADR-0042 c6/c7, ticket M3).
-- Hand-authored (the local env blocks `prisma migrate dev`; the house pattern
-- since D1) and verified with `prisma migrate deploy` + `prisma migrate diff`
-- (the pre-existing PostGIS generated-geometry drift is the known, expected
-- exception).
--
-- Three concerns in one migration because they are one decision (ADR-0042):
--   1. The tracker_device aggregate — the physical hardware GPS units,
--      IMEI-unique, at most one mounted per vehicle.
--   2. gps_ping.ignition — additive nullable rider; hardware trackers report
--      engine state (idle-vs-parked) and adding a column to the system's
--      highest-row-count table later would be painful. Phone/synthetic pings
--      simply leave it NULL.
--   3. The composite (vehicleId, timestamp DESC) index replacing the original
--      single-column vehicleId index: the composite serves the per-vehicle
--      trace filter (prefix) AND the hot latest-fix-per-vehicle query the
--      live map polls, so the single-column index would be pure write
--      overhead on every ping insert.

-- CreateEnum
CREATE TYPE "TrackerStatus" AS ENUM ('ACTIVE', 'SPARE', 'RETIRED');

-- CreateTable
CREATE TABLE "tracker_device" (
    "id" TEXT NOT NULL,
    "imei" TEXT NOT NULL,
    "vehicleId" TEXT,
    "label" TEXT,
    "simMsisdn" TEXT,
    "status" "TrackerStatus" NOT NULL DEFAULT 'SPARE',
    "installedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "tracker_device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tracker_device_imei_key" ON "tracker_device"("imei");

-- CreateIndex
CREATE UNIQUE INDEX "tracker_device_vehicleId_key" ON "tracker_device"("vehicleId");

-- CreateIndex
CREATE INDEX "tracker_device_status_idx" ON "tracker_device"("status");

-- CreateIndex
CREATE INDEX "tracker_device_createdById_idx" ON "tracker_device"("createdById");

-- AddForeignKey
ALTER TABLE "tracker_device" ADD CONSTRAINT "tracker_device_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracker_device" ADD CONSTRAINT "tracker_device_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "gps_ping" ADD COLUMN "ignition" BOOLEAN;

-- DropIndex (superseded by the composite below — its prefix serves the same
-- lookups, so keeping both would only tax every ping insert)
DROP INDEX "gps_ping_vehicleId_idx";

-- CreateIndex
CREATE INDEX "gps_ping_vehicleId_timestamp_idx" ON "gps_ping"("vehicleId", "timestamp" DESC);
