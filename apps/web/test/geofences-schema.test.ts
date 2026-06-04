import { describe, expect, test } from "vitest";

import {
  CreateGeofenceFormSchema,
  validateVertexInput,
  wktToVertexInput,
} from "../src/lib/geofences-schema";

/**
 * Pins the web-side geofence helpers (ADR-0030 G3). The coordinate-entry
 * form's `lon,lat;…` validation mirrors the API's shared PolygonParser
 * (apps/api/src/common/wkt.ts), and `wktToVertexInput` is the edit-form
 * pre-fill inverse of the stored `POLYGON((…))` WKT. These are the bits
 * unique to G3 (the rest of the slice is wiring mirroring the customers
 * aggregate), so they earn the unit coverage.
 *
 * Kathmandu coordinates (lon 85.x, lat 27.x) are used throughout so a
 * swapped X,Y axis — the PostGIS foot-gun the API tests also pin — would
 * be unmissable here.
 */

describe("validateVertexInput", () => {
  test("accepts a valid 3-vertex (unclosed) triangle", () => {
    expect(validateVertexInput("85.30,27.70;85.31,27.70;85.31,27.71")).toBeNull();
  });

  test("accepts an already-closed ring (first vertex repeated last)", () => {
    expect(validateVertexInput("85.30,27.70;85.31,27.70;85.31,27.71;85.30,27.70")).toBeNull();
  });

  test("tolerates surrounding whitespace and trailing separators", () => {
    expect(validateVertexInput(" 85.30, 27.70 ; 85.31,27.70 ; 85.31,27.71 ;")).toBeNull();
  });

  test("rejects fewer than 3 vertices", () => {
    const error = validateVertexInput("85.30,27.70;85.31,27.70");
    expect(error).toMatch(/at least 3 vertices/);
  });

  test("rejects a vertex that is not exactly lon,lat", () => {
    const error = validateVertexInput("85.30,27.70;85.31;85.31,27.71");
    expect(error).toMatch(/must be "lon,lat"/);
  });

  test("rejects a longitude outside [-180, 180]", () => {
    const error = validateVertexInput("185.0,27.70;85.31,27.70;85.31,27.71");
    expect(error).toMatch(/longitude .* between -180 and 180/);
  });

  test("rejects a latitude outside [-90, 90]", () => {
    const error = validateVertexInput("85.30,127.0;85.31,27.70;85.31,27.71");
    expect(error).toMatch(/latitude .* between -90 and 90/);
  });

  test("rejects a non-numeric coordinate", () => {
    const error = validateVertexInput("85.30,north;85.31,27.70;85.31,27.71");
    expect(error).toMatch(/latitude/);
  });
});

describe("wktToVertexInput", () => {
  test("converts a stored POLYGON((…)) ring to the lon,lat;… representation verbatim", () => {
    expect(wktToVertexInput("POLYGON((85.3 27.7, 85.31 27.7, 85.31 27.71, 85.3 27.7))")).toBe(
      "85.3,27.7;85.31,27.7;85.31,27.71;85.3,27.7",
    );
  });

  test("preserves the lon,lat (X,Y) order — a swap would be visible here", () => {
    // The first vertex lon=85.3 lat=27.7 must come out as "85.3,27.7",
    // never "27.7,85.3".
    const out = wktToVertexInput("POLYGON((85.3 27.7, 85.4 27.8, 85.5 27.9, 85.3 27.7))");
    expect(out.split(";")[0]).toBe("85.3,27.7");
  });

  test("round-trips back through validateVertexInput as a valid ring", () => {
    const vertices = wktToVertexInput("POLYGON((85.3 27.7, 85.31 27.7, 85.31 27.71, 85.3 27.7))");
    expect(validateVertexInput(vertices)).toBeNull();
  });

  test("returns '' for a non-POLYGON or unparseable WKT (defensive fallback)", () => {
    expect(wktToVertexInput("POINT(85.3 27.7)")).toBe("");
    expect(wktToVertexInput("not wkt at all")).toBe("");
    expect(wktToVertexInput("")).toBe("");
  });
});

describe("CreateGeofenceFormSchema ownership refine", () => {
  const boundary = "85.30,27.70;85.31,27.70;85.31,27.71";

  test("accepts a DEPOT with no customer", () => {
    const result = CreateGeofenceFormSchema.safeParse({
      name: "Balaju yard",
      type: "DEPOT",
      boundary,
      customerId: "",
    });
    expect(result.success).toBe(true);
  });

  test("accepts a CUSTOMER_SITE with a customer", () => {
    const result = CreateGeofenceFormSchema.safeParse({
      name: "Naxal site",
      type: "CUSTOMER_SITE",
      boundary,
      customerId: "clcustomer0000000000000000",
    });
    expect(result.success).toBe(true);
  });

  test("rejects a CUSTOMER_SITE with no customer, pinned to customerId", () => {
    const result = CreateGeofenceFormSchema.safeParse({
      name: "Naxal site",
      type: "CUSTOMER_SITE",
      boundary,
      customerId: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "customerId");
      expect(issue?.message).toMatch(/requires a customer/);
    }
  });

  test("rejects a DEPOT that carries a customer, pinned to customerId", () => {
    const result = CreateGeofenceFormSchema.safeParse({
      name: "Balaju yard",
      type: "DEPOT",
      boundary,
      customerId: "clcustomer0000000000000000",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "customerId");
      expect(issue?.message).toMatch(/Only a customer-site geofence/);
    }
  });

  test("rejects a degenerate boundary, pinned to boundary", () => {
    const result = CreateGeofenceFormSchema.safeParse({
      name: "Bad fence",
      type: "DEPOT",
      boundary: "85.30,27.70",
      customerId: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "boundary");
      expect(issue?.message).toMatch(/at least 3 vertices/);
    }
  });
});
