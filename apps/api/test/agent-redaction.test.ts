import { describe, expect, test } from "vitest";

import {
  AGENT_MASK_KEYS,
  AGENT_STRIP_KEYS,
  maskLast4,
  redactForModel,
} from "../src/modules/agent/redact-for-model";
import { GPS_SPAN_SCRUB_DENYLIST } from "../src/observability/span-scrub";

// Exhaustive unit tests for the ADR-0043 c6 redaction contract (ticket A4) —
// the Tier boundary between the database and a foreign-hosted LLM. Pure, no
// DB: the walker's semantics are pinned key by key, at top level, nested, and
// inside arrays, because a single missed shape here is a Tier-5/Tier-2 egress.

describe("redaction key sets", () => {
  test("the strip set is the canonical GPS denylist plus dateOfBirth and boundaryWkt", () => {
    for (const key of GPS_SPAN_SCRUB_DENYLIST) {
      expect(AGENT_STRIP_KEYS.has(key.toLowerCase())).toBe(true);
    }
    expect(AGENT_STRIP_KEYS.has("dateofbirth")).toBe(true);
    expect(AGENT_STRIP_KEYS.has("boundarywkt")).toBe(true);
    // The PASS list must never creep into the strip set (c6: names/phones are
    // operational contact data, PO-accepted).
    for (const passKey of ["fullname", "phone", "email", "contactperson", "name"]) {
      expect(AGENT_STRIP_KEYS.has(passKey)).toBe(false);
    }
  });

  test("the mask set is exactly licenseNumber", () => {
    expect([...AGENT_MASK_KEYS]).toEqual(["licensenumber"]);
  });
});

describe("maskLast4", () => {
  test("masks to the last 4 characters", () => {
    expect(maskLast4("12-345-6789")).toBe("***6789");
    expect(maskLast4("LIC-98765432")).toBe("***5432");
  });

  test("collapses short values entirely (never reveals the whole value)", () => {
    expect(maskLast4("1234")).toBe("***");
    expect(maskLast4("12")).toBe("***");
    expect(maskLast4("")).toBe("***");
  });
});

describe("redactForModel", () => {
  test("strips every strip key at top level", () => {
    const input: Record<string, unknown> = { keep: "yes" };
    for (const key of AGENT_STRIP_KEYS) {
      input[key] = "sensitive";
    }
    const result = redactForModel(input) as Record<string, unknown>;
    expect(result).toEqual({ keep: "yes" });
  });

  test("strips and masks NESTED objects — the TripDetail.driver case", () => {
    const tripDetail = {
      id: "trip_1",
      status: "COMPLETED",
      driver: {
        id: "drv_1",
        fullName: "Ram Bahadur Shrestha",
        phone: "+977-9800000000",
        licenseNumber: "12-345-6789",
        dateOfBirth: new Date("1990-01-01T00:00:00Z"),
      },
      vehicle: { id: "veh_1", registrationNumber: "BA-1-PA-1234" },
    };

    const result = redactForModel(tripDetail) as {
      driver: Record<string, unknown>;
      vehicle: Record<string, unknown>;
    };

    expect(result.driver.dateOfBirth).toBeUndefined();
    expect("dateOfBirth" in result.driver).toBe(false);
    expect(result.driver.licenseNumber).toBe("***6789");
    // The pass list survives untouched.
    expect(result.driver.fullName).toBe("Ram Bahadur Shrestha");
    expect(result.driver.phone).toBe("+977-9800000000");
    expect(result.vehicle.registrationNumber).toBe("BA-1-PA-1234");
  });

  test("redacts inside arrays and keeps positions stable", () => {
    const rows = [
      { licenseNumber: "AAAA-1111", latitude: 27.7, name: "one" },
      { licenseNumber: "BBBB-2222", longitude: 85.3, name: "two" },
    ];
    const result = redactForModel(rows) as Record<string, unknown>[];
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ licenseNumber: "***1111", name: "one" });
    expect(result[1]).toEqual({ licenseNumber: "***2222", name: "two" });
  });

  test("key matching is case-insensitive", () => {
    const result = redactForModel({
      DateOfBirth: "1990-01-01",
      LICENSENUMBER: "XYZW-9999",
      BoundaryWKT: "POLYGON((...))",
    }) as Record<string, unknown>;
    expect(result).toEqual({ LICENSENUMBER: "***9999" });
  });

  test("masking a non-string licenseNumber fails CLOSED to a strip", () => {
    const result = redactForModel({ licenseNumber: 123456789, keep: true }) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ keep: true });
  });

  test("GPS coordinate/trail keys are stripped wherever they appear", () => {
    const result = redactForModel({
      ping: { latitude: 27.7172, longitude: 85.324, speed: 62, heading: 270, vehicleId: "veh_1" },
      trail: [{ lat: 1, lng: 2 }, { coordinates: "27.7,85.3" }],
    }) as { ping: Record<string, unknown>; trail: Record<string, unknown>[] };
    expect(result.ping).toEqual({ vehicleId: "veh_1" });
    expect(result.trail).toEqual([{}, {}]);
  });

  test("Dates become ISO strings; BigInt becomes a decimal string (JSON-safe)", () => {
    const result = redactForModel({
      when: new Date("2026-07-02T10:00:00.000Z"),
      big: 9007199254740993n,
    }) as Record<string, unknown>;
    expect(result.when).toBe("2026-07-02T10:00:00.000Z");
    expect(result.big).toBe("9007199254740993");
  });

  test("null/undefined/primitives pass; functions and symbols are dropped", () => {
    expect(redactForModel(null)).toBeNull();
    expect(redactForModel(42)).toBe(42);
    expect(redactForModel("text")).toBe("text");
    expect(redactForModel(false)).toBe(false);
    const result = redactForModel({
      ok: 1,
      gone: () => "x",
      alsoGone: Symbol("s"),
      nothing: null,
    }) as Record<string, unknown>;
    expect(result).toEqual({ ok: 1, nothing: null });
  });

  test("cycle-safe: a revisited object renders as null instead of recursing forever", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    const result = redactForModel(node) as Record<string, unknown>;
    expect(result.name).toBe("a");
    expect(result.self).toBeNull();
  });

  test("output is always JSON.stringify-safe", () => {
    const gnarly = {
      driver: { licenseNumber: "ABCD-4321", dateOfBirth: new Date() },
      usage: 123n,
      list: [new Date("2026-01-01"), 5n, null],
    };
    expect(() => JSON.stringify(redactForModel(gnarly))).not.toThrow();
  });

  test("never mutates its input", () => {
    const input = {
      driver: { licenseNumber: "ABCD-4321", dateOfBirth: "1990-01-01", fullName: "Ram" },
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    redactForModel(input);
    expect(input).toEqual(snapshot);
  });
});
