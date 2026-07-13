import { describe, expect, it } from "@jest/globals";

import {
  ARRIVAL_RADIUS_M,
  arrivalQuery,
  arrivalState,
  arrivalStateText,
  type ArrivalStatus,
} from "./arrival";

describe("arrivalQuery", () => {
  it("centres the circle on the Site pin with the provisional radius", () => {
    expect(arrivalQuery({ latitude: 27.7172, longitude: 85.324 })).toEqual({
      centerLatitude: 27.7172,
      centerLongitude: 85.324,
      radiusMeters: ARRIVAL_RADIUS_M,
    });
  });

  it("keeps the provisional radius within the server's [1, 500000] bound", () => {
    expect(ARRIVAL_RADIUS_M).toBeGreaterThanOrEqual(1);
    expect(ARRIVAL_RADIUS_M).toBeLessThanOrEqual(500_000);
  });
});

describe("arrivalState", () => {
  const withInside = (inside: boolean | null): ArrivalStatus => ({
    inside,
    latestFixAt: "2026-07-13T00:00:00.000Z",
  });

  it("maps inside:true → arrived", () => {
    expect(arrivalState(withInside(true))).toBe("arrived");
  });

  it("maps inside:false → away", () => {
    expect(arrivalState(withInside(false))).toBe("away");
  });

  it("maps inside:null (no fix yet) → unknown, NOT away (no false 'not arrived')", () => {
    expect(arrivalState(withInside(null))).toBe("unknown");
  });

  it("maps a null status (read failed / absent) → unknown", () => {
    expect(arrivalState(null)).toBe("unknown");
  });
});

describe("arrivalStateText", () => {
  it("gives each state its driver-facing label", () => {
    expect(arrivalStateText("arrived")).toBe("Arrived");
    expect(arrivalStateText("away")).toBe("Not yet");
    expect(arrivalStateText("unknown")).toBe("Location unknown");
  });
});
