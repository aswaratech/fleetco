import { describe, expect, test } from "vitest";

import {
  CreateSiteFormSchema,
  formatCoord,
  parseLatLng,
  validateLatitude,
  validateLongitude,
} from "../src/lib/sites-schema";

/**
 * Pins the web-side Site helpers (ADR-0047 W5). The coordinate-entry
 * validation mirrors the API's Latitude / Longitude schemas
 * (apps/api/src/modules/sites/sites.schemas.ts), and formatCoord / parseLatLng
 * are the pure map ↔ string bridge the map island builds on. These are the
 * bits unique to W5 (the rest of the slice is wiring mirroring the geofences
 * aggregate), so they earn the unit coverage.
 *
 * Kathmandu coordinates (lat 27.x, lng 85.x) are used throughout so a swapped
 * X,Y axis — the PostGIS foot-gun the API tests also pin — would be unmissable
 * here (latitude never exceeds 90, longitude routinely does; a swap moves the
 * pin off the planet).
 */

describe("validateLatitude", () => {
  test("accepts a valid Kathmandu latitude", () => {
    expect(validateLatitude("27.7172")).toBeNull();
  });

  test("accepts the boundary values -90 and 90", () => {
    expect(validateLatitude("-90")).toBeNull();
    expect(validateLatitude("90")).toBeNull();
  });

  test("tolerates surrounding whitespace", () => {
    expect(validateLatitude("  27.7172 ")).toBeNull();
  });

  test("rejects an empty string as required", () => {
    expect(validateLatitude("")).toMatch(/required/);
    expect(validateLatitude("   ")).toMatch(/required/);
  });

  test("rejects a non-numeric value", () => {
    expect(validateLatitude("north")).toMatch(/must be a number/);
  });

  test("rejects a latitude outside [-90, 90]", () => {
    expect(validateLatitude("90.1")).toMatch(/between -90 and 90/);
    expect(validateLatitude("-91")).toMatch(/between -90 and 90/);
    // 85.3240 is a valid LONGITUDE but an invalid LATITUDE — the swap guard.
    expect(validateLatitude("127")).toMatch(/between -90 and 90/);
  });
});

describe("validateLongitude", () => {
  test("accepts a valid Kathmandu longitude", () => {
    expect(validateLongitude("85.324")).toBeNull();
  });

  test("accepts the boundary values -180 and 180", () => {
    expect(validateLongitude("-180")).toBeNull();
    expect(validateLongitude("180")).toBeNull();
  });

  test("rejects an empty string as required", () => {
    expect(validateLongitude("")).toMatch(/required/);
  });

  test("rejects a non-numeric value", () => {
    expect(validateLongitude("east")).toMatch(/must be a number/);
  });

  test("rejects a longitude outside [-180, 180]", () => {
    expect(validateLongitude("180.5")).toMatch(/between -180 and 180/);
    expect(validateLongitude("-181")).toMatch(/between -180 and 180/);
  });
});

describe("formatCoord", () => {
  test("keeps a short decimal short (no padding zeros)", () => {
    expect(formatCoord(85.3)).toBe("85.3");
    expect(formatCoord(27)).toBe("27");
  });

  test("trims float noise to at most 6 decimals", () => {
    expect(formatCoord(85.30000000000001)).toBe("85.3");
    expect(formatCoord(27.7001234567)).toBe("27.700123");
  });

  test("never emits exponential notation for WGS84-range values", () => {
    expect(formatCoord(0.000001)).toBe("0.000001");
    expect(formatCoord(-179.999999)).toBe("-179.999999");
  });
});

describe("parseLatLng", () => {
  test("parses a valid pair into a [lat, lng] tuple", () => {
    expect(parseLatLng("27.7172", "85.324")).toEqual([27.7172, 85.324]);
  });

  test("preserves the [lat, lng] order — a swap would be visible here", () => {
    // latitude 27.7172 must come out FIRST, longitude 85.324 SECOND; never
    // [85.324, 27.7172].
    const out = parseLatLng("27.7172", "85.324");
    expect(out?.[0]).toBe(27.7172);
    expect(out?.[1]).toBe(85.324);
  });

  test("returns null when either coordinate is invalid (defensive fallback)", () => {
    expect(parseLatLng("", "85.324")).toBeNull();
    expect(parseLatLng("27.7172", "")).toBeNull();
    expect(parseLatLng("north", "85.324")).toBeNull();
    expect(parseLatLng("91", "85.324")).toBeNull();
    expect(parseLatLng("27.7172", "181")).toBeNull();
  });
});

describe("CreateSiteFormSchema", () => {
  const valid = {
    name: "Kalimati Crusher",
    kind: "CRUSHER",
    latitude: "27.7172",
    longitude: "85.324",
    address: "",
    contactName: "",
    contactPhone: "",
  };

  test("accepts a valid required-only site", () => {
    expect(CreateSiteFormSchema.safeParse(valid).success).toBe(true);
  });

  test("accepts a site with the optional address + contact filled", () => {
    const result = CreateSiteFormSchema.safeParse({
      ...valid,
      kind: "DELIVERY_SITE",
      address: "Pokhara, ward 5",
      contactName: "Ram",
      contactPhone: "98-1234-5678",
    });
    expect(result.success).toBe(true);
  });

  test("rejects a blank name, pinned to name", () => {
    const result = CreateSiteFormSchema.safeParse({ ...valid, name: "   " });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.find((i) => i.path[0] === "name")?.message).toMatch(/required/);
    }
  });

  test("rejects an unknown kind, pinned to kind", () => {
    const result = CreateSiteFormSchema.safeParse({ ...valid, kind: "QUARRY" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "kind")).toBe(true);
    }
  });

  test("rejects an out-of-range latitude, pinned to latitude", () => {
    const result = CreateSiteFormSchema.safeParse({ ...valid, latitude: "95" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.find((i) => i.path[0] === "latitude")?.message).toMatch(
        /between -90 and 90/,
      );
    }
  });

  test("rejects a missing pin (empty coordinates), pinned to latitude/longitude", () => {
    const result = CreateSiteFormSchema.safeParse({ ...valid, latitude: "", longitude: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "latitude")).toBe(true);
      expect(result.error.issues.some((i) => i.path[0] === "longitude")).toBe(true);
    }
  });
});
