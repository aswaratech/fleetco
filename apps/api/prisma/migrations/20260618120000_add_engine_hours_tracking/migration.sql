-- CreateEnum
-- Meter-type discriminator (ADR-0036). Says which meter(s) an asset has,
-- independent of whether a reading has been captured yet.
CREATE TYPE "meter_type" AS ENUM ('ODOMETER_KM', 'ENGINE_HOURS', 'BOTH');

-- AlterTable
-- Engine-hours metering dimension on Vehicle (ADR-0036). Additive +
-- backward-compatible: meterType defaults to ODOMETER_KM so every existing
-- vehicle keeps its km-only behavior with no data change, and the two hours
-- columns are nullable (null = "no hour-meter" for a km asset, or "SMR not yet
-- keyed in" for an hour-metered asset). Stored as integer TENTHS OF AN HOUR
-- (deci-hours) — never a float — the FuelLog.litersMl integer-minor-units
-- precedent, mirroring odometerStartKm/odometerCurrentKm one-for-one.
ALTER TABLE "vehicle" ADD COLUMN     "engineHoursCurrent" INTEGER,
ADD COLUMN     "engineHoursStart" INTEGER,
ADD COLUMN     "meterType" "meter_type" NOT NULL DEFAULT 'ODOMETER_KM';

-- AlterTable
-- Trip start/end engine-hours readings (ADR-0036 c3), the hours rotation of
-- startOdometerKm/endOdometerKm, captured by the same →IN_PROGRESS / →COMPLETED
-- transitions. Nullable: a PLANNED trip has none yet, and a km-only vehicle's
-- trips never capture hours. Integer TENTHS OF AN HOUR (deci-hours).
ALTER TABLE "trip" ADD COLUMN     "endEngineHours" INTEGER,
ADD COLUMN     "startEngineHours" INTEGER;
