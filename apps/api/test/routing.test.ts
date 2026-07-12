import { describe, expect, test } from "vitest";

import { LiveRoutingProviderStub } from "../src/modules/routing/live.routing-provider";
import { MockRoutingProvider, haversineMeters } from "../src/modules/routing/mock.routing-provider";
import { routingProviderFactory } from "../src/modules/routing/routing.module";
import {
  type LatLng,
  RoutingNotConfiguredError,
  RoutingProvider,
} from "../src/modules/routing/routing-provider";

// Unit tests for the RoutingProvider seam (ADR-0047 c9), mirroring
// llm-client.test.ts: the Mock is fully deterministic and opens no socket (the
// dev/CI-hermetic guarantee, asserted not assumed), the exported factory's
// selection is proven in isolation from ambient env, and the live stub fails
// loudly. The road-winding factor (1.3) and assumed haul speed (~11.1 m/s) are
// the documented derivation contract and are pinned here so a silent change to
// either breaks a test.

const KATHMANDU: LatLng = { lat: 27.7172, lng: 85.324 };
const POKHARA: LatLng = { lat: 28.2096, lng: 83.9856 };

// The derivation contract the MockRoutingProvider documents (kept in sync here).
const ROAD_WINDING_FACTOR = 1.3;
const ASSUMED_SPEED_MPS = 11.1;

describe("haversineMeters", () => {
  test("one degree of longitude at the equator is ~111.2 km", () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(d).toBeGreaterThan(111_000);
    expect(d).toBeLessThan(111_400);
  });

  test("is zero for identical points and symmetric", () => {
    expect(haversineMeters(KATHMANDU, KATHMANDU)).toBe(0);
    expect(haversineMeters(KATHMANDU, POKHARA)).toBeCloseTo(haversineMeters(POKHARA, KATHMANDU), 6);
  });
});

describe("RoutingProvider contract", () => {
  test("MockRoutingProvider and LiveRoutingProviderStub are both RoutingProvider subtypes", () => {
    expect(new MockRoutingProvider()).toBeInstanceOf(RoutingProvider);
    expect(new LiveRoutingProviderStub("google", "key")).toBeInstanceOf(RoutingProvider);
  });
});

describe("routingProviderFactory (the deterministic kill switch)", () => {
  test("binds the Mock when no live provider is selected", () => {
    expect(routingProviderFactory(undefined, undefined)).toBeInstanceOf(MockRoutingProvider);
    expect(routingProviderFactory("", "")).toBeInstanceOf(MockRoutingProvider);
    expect(routingProviderFactory("mock", undefined)).toBeInstanceOf(MockRoutingProvider);
    // Case-insensitive + whitespace-tolerant so a stray "  MOCK " still degrades safely.
    expect(routingProviderFactory("  MOCK ", undefined)).toBeInstanceOf(MockRoutingProvider);
  });

  test("binds the live stub when a live provider name is selected", () => {
    expect(routingProviderFactory("google", "key")).toBeInstanceOf(LiveRoutingProviderStub);
    expect(routingProviderFactory("osrm", undefined)).toBeInstanceOf(LiveRoutingProviderStub);
  });
});

describe("MockRoutingProvider.route", () => {
  test("is deterministic — identical inputs yield an identical result", async () => {
    const a = await new MockRoutingProvider().route(KATHMANDU, POKHARA);
    const b = await new MockRoutingProvider().route(KATHMANDU, POKHARA);
    expect(a).toEqual(b);
  });

  test("geometry starts at the origin, ends at the destination, and is a polyline", async () => {
    const r = await new MockRoutingProvider().route(KATHMANDU, POKHARA);
    expect(r.geometryLatLng.length).toBeGreaterThan(2);
    expect(r.geometryLatLng[0]).toEqual([KATHMANDU.lat, KATHMANDU.lng]);
    expect(r.geometryLatLng[r.geometryLatLng.length - 1]).toEqual([POKHARA.lat, POKHARA.lng]);
  });

  test("distance = round(haversine × road-winding) and duration = round(distance / speed)", async () => {
    const r = await new MockRoutingProvider().route(KATHMANDU, POKHARA);
    const expectedDistance = Math.round(haversineMeters(KATHMANDU, POKHARA) * ROAD_WINDING_FACTOR);
    expect(r.distanceMeters).toBe(expectedDistance);
    expect(r.durationSeconds).toBe(Math.round(expectedDistance / ASSUMED_SPEED_MPS));
  });

  test("distance is monotonic in separation (farther destination ⇒ larger estimate)", async () => {
    const near = await new MockRoutingProvider().route(KATHMANDU, {
      lat: KATHMANDU.lat + 0.01,
      lng: KATHMANDU.lng + 0.01,
    });
    const far = await new MockRoutingProvider().route(KATHMANDU, POKHARA);
    expect(far.distanceMeters).toBeGreaterThan(near.distanceMeters);
  });

  test("records every call for test assertions", async () => {
    const mock = new MockRoutingProvider();
    await mock.route(KATHMANDU, POKHARA);
    await mock.route(POKHARA, KATHMANDU);
    expect(mock.requests).toEqual([
      { origin: KATHMANDU, destination: POKHARA },
      { origin: POKHARA, destination: KATHMANDU },
    ]);
  });

  test("honours a fixed result override", async () => {
    const fixed = {
      geometryLatLng: [[1, 2] as [number, number]],
      distanceMeters: 5,
      durationSeconds: 7,
    };
    const r = await new MockRoutingProvider({ result: fixed }).route(KATHMANDU, POKHARA);
    expect(r).toEqual(fixed);
  });

  test("honours a thrown-error override", async () => {
    const boom = new Error("boom");
    await expect(
      new MockRoutingProvider({ throwError: boom }).route(KATHMANDU, POKHARA),
    ).rejects.toBe(boom);
  });
});

describe("LiveRoutingProviderStub.route", () => {
  test("fails loudly with RoutingNotConfiguredError naming the selected provider", async () => {
    // Typed as the seam it is bound to via DI, so route() is called exactly as
    // the controller calls it (the stub itself ignores the coordinates).
    const stub: RoutingProvider = new LiveRoutingProviderStub("google", "a-key");
    await expect(stub.route(KATHMANDU, POKHARA)).rejects.toBeInstanceOf(RoutingNotConfiguredError);
    await expect(stub.route(KATHMANDU, POKHARA)).rejects.toThrow(/google/);
    await expect(stub.route(KATHMANDU, POKHARA)).rejects.toThrow(/M1-gated/);
  });

  test("never leaks the API key value, only its presence", async () => {
    const stub: RoutingProvider = new LiveRoutingProviderStub("google", "super-secret-key");
    await expect(stub.route(KATHMANDU, POKHARA)).rejects.toThrow(/key present/);
    const absent: RoutingProvider = new LiveRoutingProviderStub("google", undefined);
    await expect(absent.route(KATHMANDU, POKHARA)).rejects.toThrow(/key absent/);
  });
});
