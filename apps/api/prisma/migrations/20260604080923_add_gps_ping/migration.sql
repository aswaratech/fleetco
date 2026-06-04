-- GpsPing — first PostGIS geometry in FleetCo (ADR-0029 commitment 8).
-- This migration is HAND-EDITED beyond Prisma's generated output in two
-- places Prisma's schema language cannot express:
--   1. The "geometry" column is GENERATED ALWAYS ... STORED, derived by
--      the database from the native Float longitude/latitude via
--      ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326). Argument
--      order is X,Y = lon,lat (the classic PostGIS foot-gun); the
--      round-trip test (apps/api/test/gps-ping.schema.test.ts) asserts
--      ST_X = longitude and ST_Y = latitude. Because the column is
--      GENERATED ... STORED, inserts must NOT supply it — Prisma satisfies
--      this for free by inserting only the Float columns, and the column
--      is declared Unsupported("geometry(Point, 4326)")? in schema.prisma
--      so Prisma tracks it for migrate-diff but never selects/inserts it.
--   2. The "gps_ping_geometry_idx" GIST index for spatial queries.
-- Applied migrations are never edited after merge (CLAUDE.md); this SQL is
-- authored once, here. `prisma migrate diff` reports no drift against the
-- Unsupported column. See ADR-0029.
-- CreateTable
CREATE TABLE "gps_ping" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "tripId" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "altitude" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "geometry" geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "gps_ping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gps_ping_vehicleId_idx" ON "gps_ping"("vehicleId");

-- CreateIndex
CREATE INDEX "gps_ping_tripId_idx" ON "gps_ping"("tripId");

-- CreateIndex
CREATE INDEX "gps_ping_timestamp_idx" ON "gps_ping"("timestamp" DESC);

-- CreateIndex
CREATE INDEX "gps_ping_createdById_idx" ON "gps_ping"("createdById");

-- AddForeignKey
ALTER TABLE "gps_ping" ADD CONSTRAINT "gps_ping_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_ping" ADD CONSTRAINT "gps_ping_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gps_ping" ADD CONSTRAINT "gps_ping_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (HAND-AUTHORED): GIST spatial index on the generated
-- geometry column — enables ST_Contains / ST_DWithin geofencing (T5).
-- Prisma's schema language cannot express a GIST index on an Unsupported
-- column, so it is authored here. See the file header and ADR-0029 c8.
CREATE INDEX "gps_ping_geometry_idx" ON "gps_ping" USING GIST ("geometry");
