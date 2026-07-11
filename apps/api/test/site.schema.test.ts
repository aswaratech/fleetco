import { Test, type TestingModule } from "@nestjs/testing";
import { MaterialType, SiteKind, TripStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { seedSite } from "./fixtures/site";
import { seedDriver, seedUser, seedVehicle } from "./fixtures/trip";

// Schema-level integration tests for the trip-dispatch program (ADR-0047 W2)
// against a real PostGIS-enabled Postgres. Two aggregates in one file, the
// analogue of gps-ping.schema.test.ts / geofence.schema.test.ts:
//
//   1. Site — the reusable pinned pickup/drop-off location (ADR-0047 c4)
//      reuses the GpsPing hybrid Point storage: native Float
//      latitude/longitude PLUS a GENERATED ALWAYS AS
//        ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) STORED
//      geometry(Point, 4326) column with a GIST index. The load-bearing
//      assertion is the ST_MakePoint argument-order guard — ST_MakePoint
//      takes X,Y = lon,lat (the classic PostGIS foot-gun). A Kathmandu pin
//      (lat 27.x, lon 85.x) makes a lon/lat swap unmissable.
//
//   2. Trip — the order columns + milestone timestamps + the OFFERED /
//      ACCEPTED statuses (ADR-0047 c1/c3) round-trip through Prisma and the
//      new FKs; a pre-dispatch trip leaves every order column null; and a
//      Site referenced by a trip cannot be hard-deleted (onDelete: Restrict,
//      the DB half of the W3 delete-blocker).
//
// Shape mirrors gps-ping.schema.test.ts: one TestingModule per file,
// beforeEach truncates via resetDb(), the seed helpers wire the FK parents.

describe("Site + Trip-dispatch schema (ADR-0047 W2)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let adminId: string;

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
  });

  // ── Site: the hybrid Point storage ──────────────────────────────────────

  test("Site generated geometry: ST_X returns longitude, ST_Y returns latitude (ST_MakePoint(lon, lat) order)", async () => {
    const site = await seedSite(prisma, {
      createdById: adminId,
      latitude: KATHMANDU_LAT,
      longitude: KATHMANDU_LON,
    });

    // Read the generated geometry back via PostGIS accessors. Prisma cannot
    // select the Unsupported geometry column, so this is raw SQL — exactly
    // the spatial-query idiom the hybrid representation confines raw SQL to
    // (ADR-0047 c4 / ADR-0029 c8). $queryRaw parameterizes the id.
    const rows = await prisma.$queryRaw<{ lon: number; lat: number; srid: number }[]>`
      SELECT ST_X("geometry") AS lon, ST_Y("geometry") AS lat, ST_SRID("geometry") AS srid
      FROM "site"
      WHERE "id" = ${site.id}
    `;

    expect(rows).toHaveLength(1);
    const row = rows[0];
    // The guard: X is longitude, Y is latitude. A ST_MakePoint(lat, lon)
    // swap would flip these and fail this assertion.
    expect(row.lon).toBeCloseTo(KATHMANDU_LON, 6);
    expect(row.lat).toBeCloseTo(KATHMANDU_LAT, 6);
    // SRID 4326 (WGS84) — the future distance/arrival queries depend on it.
    expect(Number(row.srid)).toBe(4326);
  });

  test("Site plain Prisma read returns the native Float latitude/longitude; geometry is not exposed", async () => {
    const site = await seedSite(prisma, {
      createdById: adminId,
      name: "Kalimati Crusher",
      kind: SiteKind.CRUSHER,
      latitude: KATHMANDU_LAT,
      longitude: KATHMANDU_LON,
      address: "Kalimati, Kathmandu",
    });

    // The canonical columns are the type-safe Float lat/lon — Prisma reads
    // them natively (no raw SQL), the whole point of the hybrid for the
    // type-safe CRUD path W3 builds. The Unsupported `geometry` column is
    // absent from the generated Site type entirely (a compile-time
    // guarantee: `found.geometry` would not type-check), so Prisma never
    // selects it.
    const found = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
    expect(found.latitude).toBeCloseTo(KATHMANDU_LAT, 6);
    expect(found.longitude).toBeCloseTo(KATHMANDU_LON, 6);
    expect(found.name).toBe("Kalimati Crusher");
    expect(found.kind).toBe("CRUSHER");
    expect(found.address).toBe("Kalimati, Kathmandu");
  });

  test("Site optional address/contact persist as null when omitted", async () => {
    // address / contactName / contactPhone are nullable (ADR-0047 c4/c6);
    // the default helper leaves them null. Pin that the columns truly store
    // null rather than "" (the empty case is null, the house convention).
    const site = await seedSite(prisma, { createdById: adminId });
    const found = await prisma.site.findUniqueOrThrow({ where: { id: site.id } });
    expect(found.address).toBeNull();
    expect(found.contactName).toBeNull();
    expect(found.contactPhone).toBeNull();
  });

  // ── Trip: the dispatch order columns, timestamps, and new statuses ──────

  test("Trip persists the dispatch order columns, milestone timestamps, and the OFFERED status", async () => {
    const pickup = await seedSite(prisma, {
      createdById: adminId,
      name: "Kalimati Crusher",
      kind: SiteKind.CRUSHER,
      latitude: 27.7,
      longitude: 85.3,
    });
    const dropoff = await seedSite(prisma, {
      createdById: adminId,
      name: "Pokhara Site",
      kind: SiteKind.DELIVERY_SITE,
      latitude: 28.2096,
      longitude: 83.9856,
    });
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId);

    const offeredAt = new Date("2026-07-12T03:00:00.000Z");
    const acceptedAt = new Date("2026-07-12T03:05:00.000Z");
    const arrivedPickupAt = new Date("2026-07-12T04:00:00.000Z");
    const loadedAt = new Date("2026-07-12T04:30:00.000Z");
    const arrivedDropoffAt = new Date("2026-07-12T09:00:00.000Z");
    const deliveredAt = new Date("2026-07-12T09:30:00.000Z");

    const created = await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.OFFERED,
        materialType: MaterialType.GRAVEL,
        pickupSiteId: pickup.id,
        dropoffSiteId: dropoff.id,
        consigneeName: "Ram Bahadur",
        consigneePhone: "+977-9800000000",
        expectedLoadCount: 3,
        specialInstructions: "Call the consignee on arrival.",
        docketNumber: "DKT-2026-0001",
        offeredAt,
        acceptedAt,
        arrivedPickupAt,
        loadedAt,
        arrivedDropoffAt,
        deliveredAt,
      },
    });

    const found = await prisma.trip.findUniqueOrThrow({
      where: { id: created.id },
      include: { pickupSite: true, dropoffSite: true },
    });

    // The two new statuses persist (proof the Prisma enum widen took).
    expect(found.status).toBe("OFFERED");
    // The order columns round-trip.
    expect(found.materialType).toBe("GRAVEL");
    expect(found.materialNote).toBeNull();
    expect(found.pickupSiteId).toBe(pickup.id);
    expect(found.dropoffSiteId).toBe(dropoff.id);
    expect(found.consigneeName).toBe("Ram Bahadur");
    expect(found.consigneePhone).toBe("+977-9800000000");
    expect(found.expectedLoadCount).toBe(3);
    expect(found.specialInstructions).toBe("Call the consignee on arrival.");
    expect(found.docketNumber).toBe("DKT-2026-0001");
    // The FK relations resolve to the seeded sites.
    expect(found.pickupSite?.name).toBe("Kalimati Crusher");
    expect(found.pickupSite?.kind).toBe("CRUSHER");
    expect(found.dropoffSite?.name).toBe("Pokhara Site");
    expect(found.dropoffSite?.kind).toBe("DELIVERY_SITE");
    // Every milestone timestamp round-trips (TIMESTAMP(3) millisecond
    // precision; the seeded instants are whole seconds).
    expect(found.offeredAt?.getTime()).toBe(offeredAt.getTime());
    expect(found.acceptedAt?.getTime()).toBe(acceptedAt.getTime());
    expect(found.arrivedPickupAt?.getTime()).toBe(arrivedPickupAt.getTime());
    expect(found.loadedAt?.getTime()).toBe(loadedAt.getTime());
    expect(found.arrivedDropoffAt?.getTime()).toBe(arrivedDropoffAt.getTime());
    expect(found.deliveredAt?.getTime()).toBe(deliveredAt.getTime());
  });

  test("Trip accepts the ACCEPTED status with MaterialType.OTHER + a materialNote", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId);
    const created = await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.ACCEPTED,
        materialType: MaterialType.OTHER,
        materialNote: "Reclaimed asphalt millings",
        acceptedAt: new Date("2026-07-12T05:00:00.000Z"),
      },
    });
    const found = await prisma.trip.findUniqueOrThrow({ where: { id: created.id } });
    expect(found.status).toBe("ACCEPTED");
    expect(found.materialType).toBe("OTHER");
    expect(found.materialNote).toBe("Reclaimed asphalt millings");
  });

  test("a pre-dispatch (PLANNED) trip leaves every order column and milestone timestamp null", async () => {
    // The order is nullable-but-present (ADR-0047 c3): a trip planned but
    // not yet dispatched carries no order. This pins the "unconstrained
    // before OFFERED" posture at the DB layer.
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId);
    const created = await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.PLANNED,
      },
    });
    const found = await prisma.trip.findUniqueOrThrow({ where: { id: created.id } });
    expect(found.status).toBe("PLANNED");
    expect(found.materialType).toBeNull();
    expect(found.materialNote).toBeNull();
    expect(found.pickupSiteId).toBeNull();
    expect(found.dropoffSiteId).toBeNull();
    expect(found.consigneeName).toBeNull();
    expect(found.consigneePhone).toBeNull();
    expect(found.expectedLoadCount).toBeNull();
    expect(found.specialInstructions).toBeNull();
    expect(found.docketNumber).toBeNull();
    expect(found.offeredAt).toBeNull();
    expect(found.acceptedAt).toBeNull();
    expect(found.arrivedPickupAt).toBeNull();
    expect(found.loadedAt).toBeNull();
    expect(found.arrivedDropoffAt).toBeNull();
    expect(found.deliveredAt).toBeNull();
  });

  test("a Site referenced by a trip cannot be hard-deleted (onDelete: Restrict → P2003)", async () => {
    // The FK delete policy (ADR-0047 c4): pickupSiteId/dropoffSiteId use
    // onDelete: Restrict, so a Site a trip depends on cannot be silently
    // deleted. W3's SitesService maps this raw P2003 to HTTP 409 (the house
    // delete-blocker); here we pin the DB constraint the mapping stands on.
    const pickup = await seedSite(prisma, { createdById: adminId });
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId);
    await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        createdById: adminId,
        status: TripStatus.OFFERED,
        pickupSiteId: pickup.id,
      },
    });

    // P2003 = Prisma's foreign-key-constraint-violation code; only a
    // PrismaClientKnownRequestError carries a `.code`, so matching it pins
    // the Restrict FK precisely.
    await expect(prisma.site.delete({ where: { id: pickup.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  });
});
