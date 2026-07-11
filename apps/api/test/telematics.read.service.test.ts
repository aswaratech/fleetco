import { getQueueToken } from "@nestjs/bullmq";
import { NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { GeofenceType, VehicleStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { GeofencesService } from "../src/modules/geofences/geofences.service";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { GeofenceStatusQuerySchema } from "../src/modules/telematics/telematics.schemas";
import {
  GPS_INGEST_QUEUE,
  TelematicsService,
  type GeofenceQuery,
} from "../src/modules/telematics/telematics.service";
import { resetDb } from "./db";
import { seedGeofence } from "./fixtures/geofence";
import { seedGpsPing } from "./fixtures/gps-ping";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Service-level tests for the T5 read split + the first PostGIS geofencing
// (ADR-0029 T5), against a REAL PostGIS-enabled Postgres — the spatial
// predicates (ST_Contains / ST_DWithin) cannot be exercised against a mock.
// Shape mirrors gps-ping.schema.test.ts: one TestingModule, beforeEach
// truncates via resetDb(), the seed helpers wire the FK parents.
//
// TelematicsService injects @InjectQueue(gps-ingest) for the INGEST path; the
// READ methods under test never touch it, so a no-op fake queue satisfies DI
// without a live Redis (the worker/ingest tests cover the real queue).

const fakeQueue = { add: async () => ({ id: "noop" }) };

// Kathmandu — lat (27.x) and lon (85.x) are far apart, so a lon/lat swap
// anywhere in the spatial path (the generated point geometry, ST_MakePoint, or
// the WKT builder) is unmissable. Same fix the schema round-trip test pins.
const KTM_LAT = 27.7172;
const KTM_LON = 85.324;

describe("TelematicsService reads + geofencing (ADR-0029 T5)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: TelematicsService;
  let adminId: string;
  let vehicleId: string;
  let otherVehicleId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    service = module.get(TelematicsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
    vehicleId = (await seedVehicle(prisma, adminId)).id;
    otherVehicleId = (await seedVehicle(prisma, adminId)).id;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // listRawPings — gps:read-raw (ADMIN-only): the full-resolution trace.
  // ─────────────────────────────────────────────────────────────────────────

  describe("listRawPings", () => {
    const at = (iso: string): Date => new Date(iso);

    async function seedFourPlusOther(): Promise<void> {
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: at("2026-02-10T08:00:00Z"),
        latitude: 27.7,
        longitude: 85.3,
      });
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: at("2026-02-12T08:00:00Z"),
        latitude: 27.71,
        longitude: 85.31,
      });
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: at("2026-02-14T08:00:00Z"),
        latitude: 27.72,
        longitude: 85.32,
      });
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: at("2026-02-16T08:00:00Z"),
        latitude: 27.73,
        longitude: 85.33,
      });
      // A ping for ANOTHER vehicle that the vehicleId filter must exclude.
      await seedGpsPing(prisma, {
        vehicleId: otherVehicleId,
        createdById: adminId,
        timestamp: at("2026-02-13T08:00:00Z"),
      });
    }

    test("returns the vehicle's pings, newest fix first, native Floats, no geometry key", async () => {
      await seedFourPlusOther();

      const all = await service.listRawPings({ vehicleId });
      expect(all.total).toBe(4); // the other vehicle's ping is excluded
      expect(all.items.map((p) => p.timestamp.toISOString())).toEqual([
        "2026-02-16T08:00:00.000Z",
        "2026-02-14T08:00:00.000Z",
        "2026-02-12T08:00:00.000Z",
        "2026-02-10T08:00:00.000Z",
      ]);
      // Native Float columns are read by Prisma; the Unsupported geometry column
      // is never selected (and not even on the type).
      expect(all.items[0].latitude).toBeCloseTo(27.73, 6);
      expect(all.items[0].longitude).toBeCloseTo(85.33, 6);
      expect("geometry" in all.items[0]).toBe(false);
    });

    test("time-bounds on `timestamp` are inclusive", async () => {
      await seedFourPlusOther();
      const win = await service.listRawPings({
        vehicleId,
        from: at("2026-02-12T00:00:00Z"),
        to: at("2026-02-14T23:59:59Z"),
      });
      expect(win.total).toBe(2);
      expect(win.items.map((p) => p.timestamp.toISOString())).toEqual([
        "2026-02-14T08:00:00.000Z",
        "2026-02-12T08:00:00.000Z",
      ]);
    });

    test("paginates with a stable total and no overlap across pages", async () => {
      await seedFourPlusOther();
      const page1 = await service.listRawPings({ vehicleId, take: 2, skip: 0 });
      const page2 = await service.listRawPings({ vehicleId, take: 2, skip: 2 });
      expect(page1.total).toBe(4); // total is the full count, not the page size
      expect(page2.total).toBe(4);
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      const ids = new Set([...page1.items, ...page2.items].map((p) => p.id));
      expect(ids.size).toBe(4); // the four are distinct — no row appears twice
    });

    test("ascending sort honours the requested direction", async () => {
      await seedFourPlusOther();
      const asc = await service.listRawPings({ vehicleId, sortBy: "timestamp", sortDir: "asc" });
      expect(asc.items.map((p) => p.timestamp.toISOString())).toEqual([
        "2026-02-10T08:00:00.000Z",
        "2026-02-12T08:00:00.000Z",
        "2026-02-14T08:00:00.000Z",
        "2026-02-16T08:00:00.000Z",
      ]);
    });

    test("an unknown vehicle yields an empty result set", async () => {
      expect(await service.listRawPings({ vehicleId: "cknonexistent000" })).toEqual({
        items: [],
        total: 0,
      });
    });

    test("an over-large take is clamped (defense-in-depth) and does not error", async () => {
      await seedGpsPing(prisma, { vehicleId, createdById: adminId });
      const res = await service.listRawPings({ vehicleId, take: 100_000 });
      expect(res.total).toBe(1);
      expect(res.items).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // latestLocation — gps:read-derived: the single latest fix (live-map view).
  // ─────────────────────────────────────────────────────────────────────────

  describe("latestLocation", () => {
    test("returns the most-recent fix only", async () => {
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: new Date("2026-02-10T08:00:00Z"),
        latitude: 27.7,
        longitude: 85.3,
      });
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: new Date("2026-02-16T08:00:00Z"),
        latitude: KTM_LAT,
        longitude: KTM_LON,
        altitude: 1400,
        speed: 12.5,
        heading: 270,
      });

      const fix = await service.latestLocation(vehicleId);
      expect(fix).not.toBeNull();
      expect(fix?.timestamp.toISOString()).toBe("2026-02-16T08:00:00.000Z");
      expect(fix?.latitude).toBeCloseTo(KTM_LAT, 6);
      expect(fix?.longitude).toBeCloseTo(KTM_LON, 6);
      expect(fix?.altitude).toBe(1400);
      expect(fix?.speed).toBe(12.5);
      expect(fix?.heading).toBe(270);
    });

    test("a vehicle with no pings → null", async () => {
      expect(await service.latestLocation(vehicleId)).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // geofenceStatus — gps:read-derived: the FIRST PostGIS geofencing.
  // ─────────────────────────────────────────────────────────────────────────

  describe("geofenceStatus — circle (ST_DWithin proximity, meters)", () => {
    test("within vs beyond the radius, meter-accurate via the geography cast", async () => {
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        latitude: KTM_LAT,
        longitude: KTM_LON,
      });

      // Center AT the fix, 100 m radius → inside (distance ≈ 0). This also
      // guards ST_MakePoint(lon, lat) order: a lat/lon swap would place the
      // center thousands of km away and flip this to false.
      const at = await service.geofenceStatus(vehicleId, {
        kind: "circle",
        centerLatitude: KTM_LAT,
        centerLongitude: KTM_LON,
        radiusMeters: 100,
      });
      expect(at.inside).toBe(true);
      expect(at.latestFixAt).not.toBeNull();

      // A center ~150 m north of the fix (0.00135° lat ≈ 150 m). With a 100 m
      // radius the fix is BEYOND; with 250 m it is WITHIN. This is the
      // meters-not-degrees proof: under a (wrong) plain-geometry ST_DWithin the
      // 0.00135° separation is « 100, so it would be "within" at radius 100 —
      // the geography cast is what makes 150 m > 100 m the correct verdict.
      const centerNorth = { centerLatitude: KTM_LAT + 0.00135, centerLongitude: KTM_LON };
      const beyond = await service.geofenceStatus(vehicleId, {
        kind: "circle",
        ...centerNorth,
        radiusMeters: 100,
      });
      expect(beyond.inside).toBe(false);
      const within = await service.geofenceStatus(vehicleId, {
        kind: "circle",
        ...centerNorth,
        radiusMeters: 250,
      });
      expect(within.inside).toBe(true);
    });

    test("a vehicle with no fix → inside null", async () => {
      const res = await service.geofenceStatus(vehicleId, {
        kind: "circle",
        centerLatitude: KTM_LAT,
        centerLongitude: KTM_LON,
        radiusMeters: 100,
      });
      expect(res.inside).toBeNull();
      expect(res.latestFixAt).toBeNull();
    });

    test("evaluates the LATEST fix when several exist", async () => {
      // Older fix is far away; newest is at KTM. A KTM geofence is "inside"
      // only because the latest fix is used (ORDER BY timestamp DESC LIMIT 1).
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: new Date("2026-02-10T08:00:00Z"),
        latitude: 28.2096,
        longitude: 83.9856, // Pokhara, ~140 km away
      });
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        timestamp: new Date("2026-02-16T08:00:00Z"),
        latitude: KTM_LAT,
        longitude: KTM_LON,
      });
      const res = await service.geofenceStatus(vehicleId, {
        kind: "circle",
        centerLatitude: KTM_LAT,
        centerLongitude: KTM_LON,
        radiusMeters: 100,
      });
      expect(res.inside).toBe(true);
      expect(res.latestFixAt?.toISOString()).toBe("2026-02-16T08:00:00.000Z");
    });
  });

  describe("geofenceStatus — polygon (ST_Contains point-in-polygon)", () => {
    // Build the GeofenceQuery from a polygon STRING via the REAL schema, so the
    // schema's `lon,lat` → WKT `lon lat` order is under test end-to-end: a swap
    // in the WKT builder would misplace the polygon and flip these verdicts.
    function polygonGeofence(spec: string): GeofenceQuery {
      const parsed = GeofenceStatusQuerySchema.parse({ polygon: spec });
      if (!parsed.polygon) throw new Error("expected a parsed polygon");
      return { kind: "polygon", wkt: parsed.polygon.wkt, vertexCount: parsed.polygon.vertexCount };
    }

    test("inside vs outside a polygon around Kathmandu", async () => {
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        latitude: KTM_LAT,
        longitude: KTM_LON,
      });

      // Box lon[85.30, 85.35] × lat[27.70, 27.74] contains KTM (85.324, 27.7172).
      const around = polygonGeofence("85.30,27.70;85.35,27.70;85.35,27.74;85.30,27.74");
      const inside = await service.geofenceStatus(vehicleId, around);
      expect(inside.inside).toBe(true);
      expect(inside.latestFixAt).not.toBeNull();

      // A box around Pokhara excludes KTM.
      const elsewhere = polygonGeofence("83.95,28.20;84.00,28.20;84.00,28.22;83.95,28.22");
      expect((await service.geofenceStatus(vehicleId, elsewhere)).inside).toBe(false);
    });

    test("lon/lat order matters — a swapped-axes box does NOT contain the point", async () => {
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        latitude: KTM_LAT,
        longitude: KTM_LON,
      });

      // Correct orientation contains the fix…
      const correct = polygonGeofence("85.30,27.70;85.35,27.70;85.35,27.74;85.30,27.74");
      expect((await service.geofenceStatus(vehicleId, correct)).inside).toBe(true);

      // …the SAME magnitudes with the axes swapped describe a polygon near
      // (lon 27, lat 85) — the Arctic, not Kathmandu — so the fix is outside.
      // This fails loudly if the point geometry or the WKT were ever read
      // lat-first.
      const swapped = polygonGeofence("27.70,85.30;27.70,85.35;27.74,85.35;27.74,85.30");
      expect((await service.geofenceStatus(vehicleId, swapped)).inside).toBe(false);
    });

    test("a vehicle with no fix → inside null", async () => {
      const none = polygonGeofence("85.30,27.70;85.35,27.70;85.35,27.74;85.30,27.74");
      const res = await service.geofenceStatus(vehicleId, none);
      expect(res.inside).toBeNull();
      expect(res.latestFixAt).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // geofenceStatus — STORED fence (geofenceId, ADR-0030 G5). The "one-line
  // change" T5 anticipated: classify against a STORED Geofence row instead of
  // a caller-parameterized fence, via the SAME ST_Contains query.
  // ─────────────────────────────────────────────────────────────────────────

  describe("geofenceStatus — stored fence (geofenceId, ADR-0030 G5)", () => {
    // Build a query-param polygon GeofenceQuery from a `lon,lat;…` string via
    // the REAL schema (same helper the polygon block uses), so the coherence
    // assertion below compares the stored path against a genuinely-parsed
    // query-param fence, not a hand-built WKT.
    function polygonGeofence(spec: string): GeofenceQuery {
      const parsed = GeofenceStatusQuerySchema.parse({ polygon: spec });
      if (!parsed.polygon) throw new Error("expected a parsed polygon");
      return { kind: "polygon", wkt: parsed.polygon.wkt, vertexCount: parsed.polygon.vertexCount };
    }

    // The vertex string whose ring is the SAME square as the seedGeofence
    // default (KATHMANDU_SQUARE_WKT: lon 85.30–85.35, lat 27.70–27.75).
    const SQUARE_VERTS = "85.30,27.70;85.35,27.70;85.35,27.75;85.30,27.75";

    test("classifies an inside fix true and an outside fix false, echoing the fence id + type", async () => {
      const fence = await seedGeofence(prisma, { createdById: adminId });

      // vehicleId's latest fix is at KTM (inside the depot square) → inside.
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        latitude: KTM_LAT,
        longitude: KTM_LON,
      });
      const inside = await service.geofenceStatus(vehicleId, {
        kind: "stored",
        geofenceId: fence.id,
      });
      expect(inside.inside).toBe(true);
      expect(inside.latestFixAt).not.toBeNull();
      // The resolved stored fence is echoed — id + type only, no coordinates.
      expect(inside.resolvedGeofence).toEqual({ id: fence.id, type: GeofenceType.DEPOT });

      // otherVehicleId's latest fix is in Pokhara (~140 km away) → outside.
      await seedGpsPing(prisma, {
        vehicleId: otherVehicleId,
        createdById: adminId,
        latitude: 28.2096,
        longitude: 83.9856,
      });
      const outside = await service.geofenceStatus(otherVehicleId, {
        kind: "stored",
        geofenceId: fence.id,
      });
      expect(outside.inside).toBe(false);
      expect(outside.resolvedGeofence).toEqual({ id: fence.id, type: GeofenceType.DEPOT });
    });

    test("an unknown geofenceId → NotFoundException (404), even with a fix present", async () => {
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        latitude: KTM_LAT,
        longitude: KTM_LON,
      });
      await expect(
        service.geofenceStatus(vehicleId, { kind: "stored", geofenceId: "cknosuchfence0000" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    test("a vehicle with no fix → inside null (the fence still resolves + echoes)", async () => {
      const fence = await seedGeofence(prisma, { createdById: adminId });
      const res = await service.geofenceStatus(vehicleId, { kind: "stored", geofenceId: fence.id });
      expect(res.inside).toBeNull();
      expect(res.latestFixAt).toBeNull();
      expect(res.resolvedGeofence).toEqual({ id: fence.id, type: GeofenceType.DEPOT });
    });

    // The load-bearing G5 assertion (ADR-0030 c1, the representation-coherence
    // guarantee made OBSERVABLE): a STORED fence and an equivalent QUERY-PARAM
    // polygon — the same ring — classify the SAME latest fix identically. They
    // share the common/wkt builder, so they cannot drift; this proves it at the
    // classification level for both an inside and an outside fix.
    test("a stored fence and an equivalent query-param polygon classify IDENTICALLY", async () => {
      const fence = await seedGeofence(prisma, { createdById: adminId });
      const equivalent = polygonGeofence(SQUARE_VERTS);

      // Inside fix: both representations must say inside.
      await seedGpsPing(prisma, {
        vehicleId,
        createdById: adminId,
        latitude: KTM_LAT,
        longitude: KTM_LON,
      });
      const storedInside = await service.geofenceStatus(vehicleId, {
        kind: "stored",
        geofenceId: fence.id,
      });
      const paramInside = await service.geofenceStatus(vehicleId, equivalent);
      expect(storedInside.inside).toBe(paramInside.inside);
      expect(storedInside.inside).toBe(true);

      // Outside fix: both representations must say outside.
      await seedGpsPing(prisma, {
        vehicleId: otherVehicleId,
        createdById: adminId,
        latitude: 28.2096,
        longitude: 83.9856,
      });
      const storedOutside = await service.geofenceStatus(otherVehicleId, {
        kind: "stored",
        geofenceId: fence.id,
      });
      const paramOutside = await service.geofenceStatus(otherVehicleId, equivalent);
      expect(storedOutside.inside).toBe(paramOutside.inside);
      expect(storedOutside.inside).toBe(false);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fleet-wide latest positions (ADR-0042 c10, ticket M7) — the live map's poll
// target. Correctness of the per-vehicle top-1 LATERAL join + the LEFT-join
// no-fix rows + the fleet boundary (RETIRED/SOLD excluded) + the
// server-computed fixAgeSeconds.
// ───────────────────────────────────────────────────────────────────────────

describe("TelematicsService.latestPositions (ADR-0042 M7)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: TelematicsService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        TelematicsService,
        GeofencesService,
        DriverScopeService,
        PrismaService,
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
      ],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    service = module.get(TelematicsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma);
  });

  test("one latest fix per vehicle; no-fix vehicles ride with fix:null; retired/sold excluded", async () => {
    // AAA: three fixes — the NEWEST (recent, moving, ignition on) must win.
    const tracked = await seedVehicle(prisma, adminId, { registrationNumber: "AAA-0001" });
    await seedGpsPing(prisma, {
      vehicleId: tracked.id,
      createdById: adminId,
      latitude: 27.7,
      longitude: 85.3,
      timestamp: new Date("2026-07-01T06:00:00Z"),
    });
    await seedGpsPing(prisma, {
      vehicleId: tracked.id,
      createdById: adminId,
      latitude: 27.71,
      longitude: 85.31,
      timestamp: new Date("2026-07-01T07:00:00Z"),
    });
    const newest = await seedGpsPing(prisma, {
      vehicleId: tracked.id,
      createdById: adminId,
      latitude: 27.7172,
      longitude: 85.324,
      speed: 12.5,
      ignition: true,
      // Recent so the server-computed age is small and assertable.
      timestamp: new Date(Date.now() - 60_000),
    });

    // BBB: in the fleet (IN_MAINTENANCE counts) but no fix yet — must appear
    // with fix:null rather than silently vanishing (the untracked list).
    await seedVehicle(prisma, adminId, {
      registrationNumber: "BBB-0002",
      status: VehicleStatus.IN_MAINTENANCE,
    });

    // CCC/DDD: RETIRED and SOLD are not "the fleet" — excluded even with a fix.
    const retired = await seedVehicle(prisma, adminId, {
      registrationNumber: "CCC-0003",
      status: VehicleStatus.RETIRED,
      retiredAt: new Date("2026-06-01"),
    });
    await seedGpsPing(prisma, { vehicleId: retired.id, createdById: adminId });
    await seedVehicle(prisma, adminId, {
      registrationNumber: "DDD-0004",
      status: VehicleStatus.SOLD,
      retiredAt: new Date("2026-06-01"),
    });

    const positions = await service.latestPositions();

    // Fleet boundary + registration ordering.
    expect(positions.map((p) => p.registrationNumber)).toEqual(["AAA-0001", "BBB-0002"]);

    const [aaa, bbb] = positions;
    // The NEWEST fix won the per-vehicle top-1 (not either older ping).
    expect(aaa.fix).not.toBeNull();
    expect(aaa.fix?.latitude).toBe(27.7172);
    expect(aaa.fix?.longitude).toBe(85.324);
    expect(aaa.fix?.speed).toBe(12.5);
    expect(aaa.fix?.ignition).toBe(true);
    expect(aaa.fix?.timestamp.getTime()).toBe(newest.timestamp.getTime());
    // Server-computed age: seeded ~60 s ago; generous ceiling for a slow CI box.
    expect(aaa.fixAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(aaa.fixAgeSeconds).toBeLessThan(300);

    expect(bbb.fix).toBeNull();
    expect(bbb.fixAgeSeconds).toBeNull();
  });

  test("an empty fleet returns an empty array (not an error)", async () => {
    expect(await service.latestPositions()).toEqual([]);
  });
});
