-- Geofence — first PostGIS geometry(Polygon, 4326) in FleetCo (ADR-0030
-- commitment 1), extending the GpsPing Point hybrid (ADR-0029 c8) to a
-- polygon. This migration is HAND-EDITED beyond Prisma's generated output:
--
--   1. The "geometry" column is GENERATED ALWAYS ... STORED, derived by the
--      database from the canonical "boundaryWkt" text column via
--      ST_GeomFromText("boundaryWkt", 4326). Unlike the Point hybrid (which
--      derives from two scalar Float columns), a polygon has no scalar
--      canonical form, so the generated expression reads the WKT text.
--      ST_GeomFromText(text, 4326) — the two-argument form with an explicit
--      SRID — is IMMUTABLE in PostGIS, which is the property a
--      GENERATED ... STORED column requires; this migration applying cleanly
--      against the CI-pinned postgis/postgis:16-3.5 is the immutability check
--      ADR-0030 c1 asks G1 to resolve (it gates G2's insert path). Because the
--      column is GENERATED ... STORED, inserts must NOT supply it — Prisma
--      satisfies this for free by inserting only "boundaryWkt", and the column
--      is declared Unsupported("geometry(Polygon, 4326)")? in schema.prisma so
--      Prisma tracks it for migrate-diff but never selects/inserts it. The
--      geometry cannot drift from boundaryWkt because the database derives it.
--   2. The "geofence_geometry_idx" GIST index for spatial queries
--      (ST_Contains / ST_DWithin), which Prisma's schema language cannot
--      express on an Unsupported column.
--
-- ALSO HAND-REMOVED: Prisma's diff emitted two SPURIOUS steps against the
-- EXISTING gps_ping hybrid — `DROP INDEX "gps_ping_geometry_idx"` and
-- `ALTER TABLE "gps_ping" ALTER COLUMN "geometry" DROP DEFAULT`. These are the
-- exact artifact the GpsPing migration header and the schema.prisma CAUTION
-- warn about: Prisma models neither the generated default nor the GIST index
-- on an Unsupported column, so it re-proposes dropping them on every new
-- migration that touches a geometry column. Applying them would break the
-- GpsPing spatial storage, so they are removed here. `prisma migrate status`
-- (migrations vs DB) is the operative drift check and reports in-sync after
-- applying; the schema-datamodel-vs-DB diff intentionally still shows the
-- generated defaults + GIST indexes, the accepted ADR-0029/ADR-0030 hybrid
-- cost. Applied via `prisma migrate deploy` (the non-interactive applier CI
-- and the test global-setup use); `migrate dev`'s post-apply diff would
-- re-propose these same spurious steps and prompt to create another migration.
--
-- Applied migrations are never edited after merge (CLAUDE.md); this SQL is
-- authored once, here. See ADR-0030 commitment 1.

-- CreateEnum
CREATE TYPE "geofence_type" AS ENUM ('DEPOT', 'CUSTOMER_SITE', 'ROUTE_CORRIDOR');

-- CreateTable
CREATE TABLE "geofence" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "geofence_type" NOT NULL,
    "boundaryWkt" TEXT NOT NULL,
    "geometry" geometry(Polygon, 4326) GENERATED ALWAYS AS (ST_GeomFromText("boundaryWkt", 4326)) STORED,
    "customerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "geofence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "geofence_type_idx" ON "geofence"("type");

-- CreateIndex
CREATE INDEX "geofence_customerId_idx" ON "geofence"("customerId");

-- CreateIndex
CREATE INDEX "geofence_createdById_idx" ON "geofence"("createdById");

-- AddForeignKey
ALTER TABLE "geofence" ADD CONSTRAINT "geofence_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geofence" ADD CONSTRAINT "geofence_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (HAND-AUTHORED): GIST spatial index on the generated geometry
-- column — enables ST_Contains / ST_DWithin geofencing. T5 (ADR-0029) built
-- the query against a caller-supplied WKT; G5 wires it to read THIS stored
-- fence's geometry. Prisma's schema language cannot express a GIST index on an
-- Unsupported column, so it is authored here. See the header and ADR-0030 c1.
CREATE INDEX "geofence_geometry_idx" ON "geofence" USING GIST ("geometry");
