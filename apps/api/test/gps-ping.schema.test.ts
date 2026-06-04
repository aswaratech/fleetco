import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { seedGpsPing } from "./fixtures/gps-ping";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Schema-level integration tests for the GpsPing hybrid coordinate
// storage (ADR-0029 commitment 8) against a real PostGIS-enabled
// Postgres. The load-bearing assertion is the ST_MakePoint
// argument-order guard: the generated geometry column is
//   GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED
// where ST_MakePoint takes X,Y = lon,lat (the classic PostGIS foot-gun).
// If a future migration swaps the arguments to ST_MakePoint(lat, lon),
// ST_X would return the latitude and ST_Y the longitude — these tests
// fail loudly. We pin a Kathmandu fix (lat 27.7172, lon 85.3240) where
// lat (27.x) and lon (85.x) are far enough apart that a swap is
// unmissable.
//
// Shape mirrors the other *.service.test.ts files: one TestingModule per
// file, beforeEach truncates via resetDb(), the seed helpers in
// test/fixtures/ wire the FK parents (User, Vehicle).

describe("GpsPing schema (hybrid PostGIS storage, ADR-0029 T2)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let adminId: string;
  let vehicleId: string;

  // Kathmandu — lat (27.x) and lon (85.x) are clearly distinct, so a
  // lon/lat swap in the generated column is unambiguous.
  const KATHMANDU_LAT = 27.7172;
  const KATHMANDU_LON = 85.324;

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
    const vehicle = await seedVehicle(prisma, adminId);
    vehicleId = vehicle.id;
  });

  test("generated geometry: ST_X returns longitude, ST_Y returns latitude (ST_MakePoint(lon, lat) order)", async () => {
    const ping = await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      latitude: KATHMANDU_LAT,
      longitude: KATHMANDU_LON,
    });

    // Read the generated geometry back via PostGIS accessors. Prisma
    // cannot select the Unsupported geometry column, so this is raw SQL
    // — exactly the spatial-query idiom the hybrid representation
    // confines raw SQL to (ADR-0029 c8). $queryRaw parameterizes the id.
    const rows = await prisma.$queryRaw<{ lon: number; lat: number; srid: number }[]>`
      SELECT ST_X("geometry") AS lon, ST_Y("geometry") AS lat, ST_SRID("geometry") AS srid
      FROM "gps_ping"
      WHERE "id" = ${ping.id}
    `;

    expect(rows).toHaveLength(1);
    const row = rows[0];
    // The guard: X is longitude, Y is latitude. A ST_MakePoint(lat, lon)
    // swap would flip these and fail this assertion.
    expect(row.lon).toBeCloseTo(KATHMANDU_LON, 6);
    expect(row.lat).toBeCloseTo(KATHMANDU_LAT, 6);
    // SRID 4326 (WGS84) — the geofencing queries (T5) depend on it.
    expect(Number(row.srid)).toBe(4326);
  });

  test("plain Prisma read returns the native Float latitude/longitude (type-safe hot path)", async () => {
    await seedGpsPing(prisma, {
      vehicleId,
      createdById: adminId,
      latitude: KATHMANDU_LAT,
      longitude: KATHMANDU_LON,
      altitude: 1400,
      speed: 12.5,
      heading: 270,
    });

    // The canonical columns are the type-safe Float lat/lon — Prisma
    // reads them natively (no raw SQL), which is the whole point of the
    // hybrid representation for the high-frequency read path. The
    // Unsupported `geometry` column is absent from the generated GpsPing
    // type entirely (a compile-time guarantee: `found.geometry` would not
    // type-check), so Prisma never selects it.
    const found = await prisma.gpsPing.findFirstOrThrow({ where: { vehicleId } });
    expect(found.latitude).toBeCloseTo(KATHMANDU_LAT, 6);
    expect(found.longitude).toBeCloseTo(KATHMANDU_LON, 6);
    expect(found.altitude).toBe(1400);
    expect(found.speed).toBe(12.5);
    expect(found.heading).toBe(270);
  });

  test("nullable movement fields persist as null when omitted", async () => {
    // altitude / speed / heading are nullable (not every fix reports
    // them); the default helper leaves them null. Pin that the column
    // truly stores null rather than 0 (a 0 heading is "due north", a
    // distinct fact from "no heading reported").
    await seedGpsPing(prisma, { vehicleId, createdById: adminId });
    const found = await prisma.gpsPing.findFirstOrThrow({ where: { vehicleId } });
    expect(found.altitude).toBeNull();
    expect(found.speed).toBeNull();
    expect(found.heading).toBeNull();
    expect(found.tripId).toBeNull();
  });
});
