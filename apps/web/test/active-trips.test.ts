import { describe, expect, test } from "vitest";

import {
  ACTIVE_TRIP_STATUSES,
  ACTIVE_TRIPS_QUERY,
  activeTripByVehicle,
  isActiveTripStatus,
  mapActiveTrips,
  toActiveTripOverlay,
  tripPins,
  type ActiveTripWireRow,
} from "../src/lib/active-trips";

// Tests for the /map active-trips layer helpers (ADR-0048), mirroring
// map-markers.test.ts: the pure helpers carry all correctness; the island
// stays untested-by-render like the rest of the Leaflet surfaces.

function wireRow(overrides: Partial<ActiveTripWireRow> = {}): ActiveTripWireRow {
  return {
    id: "trip-1",
    status: "IN_PROGRESS",
    vehicleId: "veh-1",
    startedAt: "2026-07-19T06:00:00.000Z",
    acceptedAt: "2026-07-19T05:30:00.000Z",
    offeredAt: "2026-07-19T05:00:00.000Z",
    createdAt: "2026-07-19T04:00:00.000Z",
    vehicle: { id: "veh-1", registrationNumber: "BA 1 KHA 1234" },
    driver: { id: "drv-1", fullName: "Ram Bahadur" },
    pickupSite: { id: "site-p", name: "Kalimati Crusher", latitude: 27.7, longitude: 85.3 },
    dropoffSite: { id: "site-d", name: "Pokhara Site", latitude: 28.2, longitude: 83.98 },
    consigneeName: "Should Never Copy",
    consigneePhone: "+9779800000000",
    specialInstructions: "call on arrival",
    docketNumber: "DKT-1",
    materialNote: "fine sand",
    ...overrides,
  };
}

describe("ACTIVE_TRIPS_QUERY", () => {
  test("carries exactly the three dispatched statuses and the take ceiling", () => {
    expect(ACTIVE_TRIPS_QUERY).toContain("status=OFFERED,ACCEPTED,IN_PROGRESS");
    expect(ACTIVE_TRIPS_QUERY).toContain("take=200");
  });

  test("the status set is exactly OFFERED/ACCEPTED/IN_PROGRESS", () => {
    expect([...ACTIVE_TRIP_STATUSES]).toEqual(["OFFERED", "ACCEPTED", "IN_PROGRESS"]);
    expect(isActiveTripStatus("IN_PROGRESS")).toBe(true);
    expect(isActiveTripStatus("PLANNED")).toBe(false);
    expect(isActiveTripStatus("COMPLETED")).toBe(false);
    expect(isActiveTripStatus("CANCELLED")).toBe(false);
  });
});

describe("toActiveTripOverlay", () => {
  test("projects the fields the map renders", () => {
    const overlay = toActiveTripOverlay(wireRow());
    expect(overlay).not.toBeNull();
    expect(overlay).toMatchObject({
      id: "trip-1",
      status: "IN_PROGRESS",
      vehicleId: "veh-1",
      registrationNumber: "BA 1 KHA 1234",
      driverName: "Ram Bahadur",
    });
    expect(overlay?.pickupSite?.name).toBe("Kalimati Crusher");
    expect(overlay?.dropoffSite?.name).toBe("Pokhara Site");
  });

  test("provably drops the Tier-2 and order-detail keys (ADR-0048 c4)", () => {
    const overlay = toActiveTripOverlay(wireRow());
    const keys = Object.keys(overlay as object);
    for (const forbidden of [
      "consigneeName",
      "consigneePhone",
      "specialInstructions",
      "docketNumber",
      "materialNote",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // The nested site objects are rebuilt fresh too — no stray wire keys.
    expect(Object.keys(overlay?.pickupSite ?? {})).toEqual(["id", "name", "latitude", "longitude"]);
  });

  test("returns null for a non-active status (defensive against the wire)", () => {
    expect(toActiveTripOverlay(wireRow({ status: "PLANNED" }))).toBeNull();
    expect(toActiveTripOverlay(wireRow({ status: "COMPLETED" }))).toBeNull();
  });

  test("tolerates null sites (a quick-started trip with no order)", () => {
    const overlay = toActiveTripOverlay(wireRow({ pickupSite: null, dropoffSite: null }));
    expect(overlay?.pickupSite).toBeNull();
    expect(overlay?.dropoffSite).toBeNull();
  });
});

describe("mapActiveTrips", () => {
  test("maps a page and drops non-active rows", () => {
    const rows = [wireRow(), wireRow({ id: "trip-2", status: "CANCELLED" })];
    const overlays = mapActiveTrips(rows);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.id).toBe("trip-1");
  });

  test("empty in, empty out", () => {
    expect(mapActiveTrips([])).toEqual([]);
  });
});

describe("activeTripByVehicle", () => {
  test("ranks IN_PROGRESS over ACCEPTED over OFFERED on the same vehicle", () => {
    const offered = toActiveTripOverlay(wireRow({ id: "t-off", status: "OFFERED" }));
    const accepted = toActiveTripOverlay(wireRow({ id: "t-acc", status: "ACCEPTED" }));
    const inProgress = toActiveTripOverlay(wireRow({ id: "t-inp", status: "IN_PROGRESS" }));
    if (!offered || !accepted || !inProgress) throw new Error("fixture");

    expect(activeTripByVehicle([offered, accepted]).get("veh-1")?.id).toBe("t-acc");
    expect(activeTripByVehicle([offered, inProgress, accepted]).get("veh-1")?.id).toBe("t-inp");
    // Order-independent: the same winner regardless of input order.
    expect(activeTripByVehicle([inProgress, offered, accepted]).get("veh-1")?.id).toBe("t-inp");
  });

  test("breaks a same-rank tie by recency (startedAt ?? acceptedAt ?? offeredAt ?? createdAt)", () => {
    const older = toActiveTripOverlay(
      wireRow({
        id: "t-old",
        status: "OFFERED",
        startedAt: null,
        acceptedAt: null,
        offeredAt: "2026-07-19T05:00:00.000Z",
      }),
    );
    const newer = toActiveTripOverlay(
      wireRow({
        id: "t-new",
        status: "OFFERED",
        startedAt: null,
        acceptedAt: null,
        offeredAt: "2026-07-19T07:00:00.000Z",
      }),
    );
    if (!older || !newer) throw new Error("fixture");
    expect(activeTripByVehicle([older, newer]).get("veh-1")?.id).toBe("t-new");
    expect(activeTripByVehicle([newer, older]).get("veh-1")?.id).toBe("t-new");
  });

  test("falls back to id for a full tie (deterministic across polls)", () => {
    const a = toActiveTripOverlay(
      wireRow({ id: "t-a", status: "OFFERED", startedAt: null, acceptedAt: null }),
    );
    const b = toActiveTripOverlay(
      wireRow({ id: "t-b", status: "OFFERED", startedAt: null, acceptedAt: null }),
    );
    if (!a || !b) throw new Error("fixture");
    expect(activeTripByVehicle([a, b]).get("veh-1")?.id).toBe("t-b");
    expect(activeTripByVehicle([b, a]).get("veh-1")?.id).toBe("t-b");
  });

  test("keeps one winner per vehicle while other vehicles are untouched", () => {
    const v1 = toActiveTripOverlay(wireRow({ id: "t-1" }));
    const v2 = toActiveTripOverlay(
      wireRow({
        id: "t-2",
        vehicleId: "veh-2",
        vehicle: { id: "veh-2", registrationNumber: "BA 2 KHA 5678" },
      }),
    );
    if (!v1 || !v2) throw new Error("fixture");
    const map = activeTripByVehicle([v1, v2]);
    expect(map.size).toBe(2);
    expect(map.get("veh-2")?.id).toBe("t-2");
  });
});

describe("tripPins", () => {
  test("dedupes by (siteId, role) — two trips at the same crusher share one pin", () => {
    const t1 = toActiveTripOverlay(wireRow({ id: "t-1" }));
    const t2 = toActiveTripOverlay(
      wireRow({
        id: "t-2",
        vehicleId: "veh-2",
        vehicle: { id: "veh-2", registrationNumber: "BA 2 KHA 5678" },
        dropoffSite: { id: "site-d2", name: "Butwal Site", latitude: 27.68, longitude: 83.45 },
      }),
    );
    if (!t1 || !t2) throw new Error("fixture");
    const pins = tripPins([t1, t2]);
    // Shared pickup deduped; two distinct drop-offs.
    expect(pins).toHaveLength(3);
    expect(pins.filter((p) => p.role === "pickup")).toHaveLength(1);
    expect(pins.filter((p) => p.role === "dropoff")).toHaveLength(2);
  });

  test("the same site can pin as both pickup and drop-off (different roles)", () => {
    const t = toActiveTripOverlay(
      wireRow({
        dropoffSite: { id: "site-p", name: "Kalimati Crusher", latitude: 27.7, longitude: 85.3 },
      }),
    );
    if (!t) throw new Error("fixture");
    const pins = tripPins([t]);
    expect(pins).toHaveLength(2);
    expect(new Set(pins.map((p) => p.key))).toEqual(new Set(["pickup:site-p", "dropoff:site-p"]));
  });

  test("skips null sites and yields stable keys", () => {
    const t = toActiveTripOverlay(wireRow({ pickupSite: null }));
    if (!t) throw new Error("fixture");
    const pins = tripPins([t]);
    expect(pins).toHaveLength(1);
    expect(pins[0]?.key).toBe("dropoff:site-d");
  });

  test("empty in, empty out", () => {
    expect(tripPins([])).toEqual([]);
  });
});
