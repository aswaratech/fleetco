-- Trip dispatch + driver acceptance — schema layer (ADR-0047 c1/c3/c4/c5/c6, ticket W2).
--
-- This migration is HAND-AUTHORED (per docs/runbook + CLAUDE.md: `prisma
-- migrate dev` is non-interactive-blocked in this environment). It carries two
-- things Prisma's schema language cannot express, exactly as the GpsPing (T2)
-- and Geofence (G1) migrations did:
--   1. The "site"."geometry" column is GENERATED ALWAYS ... STORED, derived by
--      the database from the native Float longitude/latitude via
--      ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326). Argument order
--      is X,Y = lon,lat (the classic PostGIS foot-gun); the round-trip test
--      (apps/api/test/site.schema.test.ts) asserts ST_X = longitude and
--      ST_Y = latitude. Because the column is GENERATED ... STORED, inserts
--      must NOT supply it — Prisma satisfies this for free by inserting only
--      the Float columns, and the column is declared
--      Unsupported("geometry(Point, 4326)")? in schema.prisma so Prisma tracks
--      it for migrate-diff but never selects/inserts it.
--   2. The "site_geometry_idx" GIST index for spatial queries.
-- Applied migrations are never edited after merge (CLAUDE.md); this SQL is
-- authored once, here. `prisma migrate diff` reports only the accepted,
-- ADR-documented PostGIS geometry drift (the generated default + GIST index on
-- the Unsupported column). See ADR-0047.

-- CreateEnum
CREATE TYPE "material_type" AS ENUM ('SAND', 'AGGREGATE', 'GRAVEL', 'STONE', 'BOULDER', 'SOIL', 'BRICKS', 'OTHER');

-- CreateEnum
CREATE TYPE "site_kind" AS ENUM ('CRUSHER', 'PIT', 'DELIVERY_SITE', 'DEPOT', 'OTHER');

-- AlterEnum: extend the trip lifecycle with the dispatch → acceptance states
-- (ADR-0047 c1). Positioned relative to the PRE-EXISTING labels PLANNED and
-- IN_PROGRESS so the physical enum order matches the schema.prisma declared
-- order (PLANNED, OFFERED, ACCEPTED, IN_PROGRESS, COMPLETED, CANCELLED) and
-- `prisma migrate diff` stays clean. PostgreSQL 16 permits ALTER TYPE ADD VALUE
-- inside the migration transaction because the new values are NOT used within
-- this migration (no column default or data references them); anchoring both
-- ADDs on pre-existing labels avoids referencing an as-yet-uncommitted value.
ALTER TYPE "trip_status" ADD VALUE 'OFFERED' AFTER 'PLANNED';
ALTER TYPE "trip_status" ADD VALUE 'ACCEPTED' BEFORE 'IN_PROGRESS';

-- AlterTable: the haulage order columns + milestone timestamps on Trip
-- (ADR-0047 c3). All nullable — a pre-dispatch (PLANNED) trip carries none;
-- the "order required at → OFFERED" and "monotonic milestone" rules are
-- service/schema cross-field checks (W4), not DB constraints.
ALTER TABLE "trip" ADD COLUMN     "materialType" "material_type",
ADD COLUMN     "materialNote" TEXT,
ADD COLUMN     "pickupSiteId" TEXT,
ADD COLUMN     "dropoffSiteId" TEXT,
ADD COLUMN     "consigneeName" TEXT,
ADD COLUMN     "consigneePhone" TEXT,
ADD COLUMN     "expectedLoadCount" INTEGER,
ADD COLUMN     "specialInstructions" TEXT,
ADD COLUMN     "docketNumber" TEXT,
ADD COLUMN     "offeredAt" TIMESTAMP(3),
ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "arrivedPickupAt" TIMESTAMP(3),
ADD COLUMN     "loadedAt" TIMESTAMP(3),
ADD COLUMN     "arrivedDropoffAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAt" TIMESTAMP(3);

-- CreateTable: the reusable pinned-location aggregate (ADR-0047 c4). The
-- "geometry" column is GENERATED ALWAYS ... STORED from the Float lon/lat —
-- HAND-AUTHORED here (see the file header). The GpsPing Point hybrid, reused.
CREATE TABLE "site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "site_kind" NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "geometry" geometry(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)) STORED,
    "address" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_kind_idx" ON "site"("kind");

-- CreateIndex
CREATE INDEX "site_createdById_idx" ON "site"("createdById");

-- CreateIndex
CREATE INDEX "trip_pickupSiteId_idx" ON "trip"("pickupSiteId");

-- CreateIndex
CREATE INDEX "trip_dropoffSiteId_idx" ON "trip"("dropoffSiteId");

-- AddForeignKey
ALTER TABLE "site" ADD CONSTRAINT "site_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_pickupSiteId_fkey" FOREIGN KEY ("pickupSiteId") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_dropoffSiteId_fkey" FOREIGN KEY ("dropoffSiteId") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (HAND-AUTHORED): GIST spatial index on the generated geometry
-- column — enables ST_Contains / ST_DWithin distance + arrival-detection
-- queries (later tickets). Prisma's schema language cannot express a GIST
-- index on an Unsupported column, so it is authored here. See the file header
-- and ADR-0047 c4.
CREATE INDEX "site_geometry_idx" ON "site" USING GIST ("geometry");
