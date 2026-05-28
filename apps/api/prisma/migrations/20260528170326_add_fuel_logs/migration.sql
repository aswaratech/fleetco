-- CreateTable
CREATE TABLE "fuel_log" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tripId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "litersMl" INTEGER NOT NULL,
    "pricePerLiterPaisa" INTEGER NOT NULL,
    "totalCostPaisa" INTEGER NOT NULL,
    "odometerReadingKm" INTEGER,
    "station" TEXT,
    "receiptNumber" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "fuel_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fuel_log_vehicleId_idx" ON "fuel_log"("vehicleId");

-- CreateIndex
CREATE INDEX "fuel_log_tripId_idx" ON "fuel_log"("tripId");

-- CreateIndex
CREATE INDEX "fuel_log_date_idx" ON "fuel_log"("date" DESC);

-- CreateIndex
CREATE INDEX "fuel_log_createdById_idx" ON "fuel_log"("createdById");

-- AddForeignKey
ALTER TABLE "fuel_log" ADD CONSTRAINT "fuel_log_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_log" ADD CONSTRAINT "fuel_log_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_log" ADD CONSTRAINT "fuel_log_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
