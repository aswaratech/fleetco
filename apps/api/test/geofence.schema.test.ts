import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { BOWTIE_WKT, KATHMANDU_SQUARE_WKT, seedGeofence } from "./fixtures/geofence";
import { seedUser } from "./fixtures/trip";

// Schema-level integration tests for the Geofence hybrid polygon storage
// (ADR-0030 commitment 1) against a real PostGIS-enabled Postgres — the
// polygon analogue of gps-ping.schema.test.ts. The load-bearing assertions:
//
//   1. The geometry column is GENERATED ALWAYS AS
//        ST_GeomFromText("boundaryWkt", 4326) STORED
//      so the database derives a geometry(Polygon, 4326) from the canonical
//      WKT text. We assert SRID 4326, type ST_Polygon, and — the foot-gun
//      guard analogous to GpsPing's ST_X/ST_Y — that each vertex's X is the
//      longitude and Y is the latitude, in the input order. WKT coordinate
//      order is `lon lat`; a swap anywhere in the generated expression would
//      put latitude where longitude belongs and ST_Contains (T5/G5) would
//      misclassify. We pin a Kathmandu square (lon 85.x, lat 27.x) where a
//      swap is unmissable.
//   2. A self-intersecting (bowtie) ring is SYNTACTICALLY a polygon — it
//      stores — but is geometrically invalid (ST_IsValid = false). This
//      documents the hazard the G2 service's ST_IsValid pre-insert gate
//      exists to reject (commitment 2).
//
// Shape mirrors gps-ping.schema.test.ts: one TestingModule per file,
// beforeEach truncates via resetDb(), the seed helpers wire the FK parents.
// A DEPOT fence (customerId null) is used, so only seedUser is needed for the
// createdById FK; the CUSTOMER_SITE ownership refine is a G2 concern.

describe("Geofence schema (hybrid PostGIS polygon storage, ADR-0030 G1)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
  });

  test("generated geometry: SRID 4326, type ST_Polygon, valid, derived from boundaryWkt", async () => {
    const fence = await seedGeofence(prisma, {
      createdById: adminId,
      boundaryWkt: KATHMANDU_SQUARE_WKT,
    });

    // Read the generated geometry back via PostGIS accessors. Prisma cannot
    // select the Unsupported geometry column, so this is raw SQL — exactly
    // the spatial-query idiom the hybrid confines raw SQL to (ADR-0030 c1).
    // $queryRaw binds the id and the comparison WKT as parameters (no
    // interpolation), the same no-injection discipline the T5 query follows.
    const rows = await prisma.$queryRaw<
      {
        type: string;
        srid: number;
        valid: boolean;
        npoints: number;
        matchesInput: boolean;
      }[]
    >`
      SELECT
        ST_GeometryType("geometry") AS type,
        ST_SRID("geometry") AS srid,
        ST_IsValid("geometry") AS valid,
        ST_NPoints("geometry") AS npoints,
        ST_OrderingEquals("geometry", ST_GeomFromText(${KATHMANDU_SQUARE_WKT}, 4326)) AS "matchesInput"
      FROM "geofence"
      WHERE "id" = ${fence.id}
    `;

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.type).toBe("ST_Polygon");
    // SRID 4326 (WGS84) — the geofencing queries (T5/G5) depend on it.
    expect(Number(row.srid)).toBe(4326);
    // The input square is a simple, non-self-intersecting ring.
    expect(row.valid).toBe(true);
    // 4 distinct corners + the repeated closing vertex.
    expect(Number(row.npoints)).toBe(5);
    // ST_OrderingEquals is true only if the stored ring has the SAME vertices
    // in the SAME order as the input WKT — i.e. the geometry round-trips the
    // canonical boundaryWkt losslessly (modulo WKT text formatting, which
    // ST_AsText would normalize and a string compare would spuriously fail).
    expect(row.matchesInput).toBe(true);
  });

  test("vertex lon/lat order is preserved (the WKT X=lon, Y=lat foot-gun guard)", async () => {
    const fence = await seedGeofence(prisma, {
      createdById: adminId,
      boundaryWkt: KATHMANDU_SQUARE_WKT,
    });

    // Extract every exterior-ring vertex and assert X = longitude, Y =
    // latitude, in input order. This is the polygon analogue of the GpsPing
    // ST_X/ST_Y assertion: if the generated expression (or a future
    // migration) swapped lon/lat, these would flip and fail loudly.
    const v = await prisma.$queryRaw<
      {
        lon1: number;
        lat1: number;
        lon2: number;
        lat2: number;
        lon3: number;
        lat3: number;
        lon4: number;
        lat4: number;
        lon5: number;
        lat5: number;
      }[]
    >`
      SELECT
        ST_X(ST_PointN(ST_ExteriorRing("geometry"), 1)) AS lon1,
        ST_Y(ST_PointN(ST_ExteriorRing("geometry"), 1)) AS lat1,
        ST_X(ST_PointN(ST_ExteriorRing("geometry"), 2)) AS lon2,
        ST_Y(ST_PointN(ST_ExteriorRing("geometry"), 2)) AS lat2,
        ST_X(ST_PointN(ST_ExteriorRing("geometry"), 3)) AS lon3,
        ST_Y(ST_PointN(ST_ExteriorRing("geometry"), 3)) AS lat3,
        ST_X(ST_PointN(ST_ExteriorRing("geometry"), 4)) AS lon4,
        ST_Y(ST_PointN(ST_ExteriorRing("geometry"), 4)) AS lat4,
        ST_X(ST_PointN(ST_ExteriorRing("geometry"), 5)) AS lon5,
        ST_Y(ST_PointN(ST_ExteriorRing("geometry"), 5)) AS lat5
      FROM "geofence"
      WHERE "id" = ${fence.id}
    `;

    expect(v).toHaveLength(1);
    const r = v[0];
    // POLYGON((85.30 27.70, 85.35 27.70, 85.35 27.75, 85.30 27.75, 85.30 27.70))
    expect(r.lon1).toBeCloseTo(85.3, 6);
    expect(r.lat1).toBeCloseTo(27.7, 6);
    expect(r.lon2).toBeCloseTo(85.35, 6);
    expect(r.lat2).toBeCloseTo(27.7, 6);
    expect(r.lon3).toBeCloseTo(85.35, 6);
    expect(r.lat3).toBeCloseTo(27.75, 6);
    expect(r.lon4).toBeCloseTo(85.3, 6);
    expect(r.lat4).toBeCloseTo(27.75, 6);
    // Closing vertex equals the first (a closed linear ring).
    expect(r.lon5).toBeCloseTo(85.3, 6);
    expect(r.lat5).toBeCloseTo(27.7, 6);
  });

  test("plain Prisma read returns the canonical boundaryWkt; geometry is not exposed", async () => {
    const fence = await seedGeofence(prisma, { createdById: adminId });

    // The canonical column is the type-safe `boundaryWkt` text — Prisma reads
    // it natively (no raw SQL), which is the whole point of the hybrid for
    // the type-safe CRUD path G2 builds. The Unsupported `geometry` column is
    // absent from the generated Geofence type entirely (a compile-time
    // guarantee: `found.geometry` would not type-check), so Prisma never
    // selects it.
    const found = await prisma.geofence.findFirstOrThrow({ where: { id: fence.id } });
    expect(found.boundaryWkt).toBe(KATHMANDU_SQUARE_WKT);
    expect(found.type).toBe("DEPOT");
    // A DEPOT fence has no owning customer (the type/ownership refine is G2).
    expect(found.customerId).toBeNull();
  });

  test("self-intersecting (bowtie) ring stores but is ST_IsValid = false (G2 service gates on this)", async () => {
    const fence = await seedGeofence(prisma, {
      createdById: adminId,
      boundaryWkt: BOWTIE_WKT,
    });

    const rows = await prisma.$queryRaw<{ type: string; valid: boolean }[]>`
      SELECT ST_GeometryType("geometry") AS type, ST_IsValid("geometry") AS valid
      FROM "geofence"
      WHERE "id" = ${fence.id}
    `;

    expect(rows).toHaveLength(1);
    // A bowtie is syntactically a POLYGON — ST_GeomFromText parses it and the
    // geometry(Polygon,4326) typmod accepts it, so the GENERATED column is
    // populated and the row stores. But it is geometrically invalid, so a
    // T5/G5 ST_Contains test would misclassify it. The G2 create/update
    // service therefore runs ST_IsValid(ST_GeomFromText($1,4326)) BEFORE the
    // write and rejects a bowtie as HTTP 400 (commitment 2). This test pins
    // the hazard that gate exists to prevent.
    expect(rows[0].type).toBe("ST_Polygon");
    expect(rows[0].valid).toBe(false);
  });
});
