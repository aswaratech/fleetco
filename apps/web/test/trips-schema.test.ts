import { describe, expect, test } from "vitest";

import { CreateTripFormSchema } from "../src/lib/trips-schema";

/**
 * Pins the meter-aware client-side cross-field rule on the trip form (ADR-0036
 * B2). The form's resolver must require the reading(s) the selected vehicle's
 * meterType calls for — km for ODOMETER_KM, engine-hours for ENGINE_HOURS, both
 * for BOTH — so an operator sees inline feedback that matches what the API will
 * accept. The API is authoritative (apps/api trips.service.test.ts pins the
 * server side); this locks the client mirror so a refactor cannot silently
 * re-require km on a pure hour-metered trip (the exact B1 bug B2 fixed).
 *
 * Each case supplies the always-required identity fields (vehicleId, driverId,
 * status) + the derived meterType, then varies the readings.
 */
const BASE = { vehicleId: "v1", driverId: "d1", notes: "" };
const COMPLETED_TIMING = { startedAt: "2026-02-01T07:00", endedAt: "2026-02-01T16:30" };

describe("CreateTripFormSchema meter-aware cross-field (ADR-0036 B2)", () => {
  test("ENGINE_HOURS COMPLETED with hours-only (no odometer) is valid", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "ENGINE_HOURS",
      ...COMPLETED_TIMING,
      startEngineHours: "2500.0",
      endEngineHours: "2509.5",
    });
    expect(result.success).toBe(true);
  });

  test("ENGINE_HOURS COMPLETED missing end hours is invalid (flags endEngineHours)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "ENGINE_HOURS",
      ...COMPLETED_TIMING,
      startEngineHours: "2500.0",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("endEngineHours"))).toBe(true);
    }
  });

  test("ENGINE_HOURS does NOT require an odometer reading", () => {
    // The symmetric guarantee: no startOdometerKm/endOdometerKm error fires.
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "ENGINE_HOURS",
      ...COMPLETED_TIMING,
      startEngineHours: "2500.0",
      endEngineHours: "2509.5",
    });
    expect(result.success).toBe(true);
  });

  test("ODOMETER_KM COMPLETED missing odometer is invalid (km still required)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "ODOMETER_KM",
      ...COMPLETED_TIMING,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("startOdometerKm"))).toBe(true);
    }
  });

  test("ODOMETER_KM COMPLETED with odometer-only (no hours) is valid", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "ODOMETER_KM",
      ...COMPLETED_TIMING,
      startOdometerKm: "80000",
      endOdometerKm: "80250",
    });
    expect(result.success).toBe(true);
  });

  test("BOTH COMPLETED requires both km and hours", () => {
    const odoOnly = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "BOTH",
      ...COMPLETED_TIMING,
      startOdometerKm: "80000",
      endOdometerKm: "80250",
    });
    expect(odoOnly.success).toBe(false); // hours missing

    const both = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "BOTH",
      ...COMPLETED_TIMING,
      startOdometerKm: "80000",
      endOdometerKm: "80250",
      startEngineHours: "1000.0",
      endEngineHours: "1008.0",
    });
    expect(both.success).toBe(true);
  });

  test("ENGINE_HOURS IN_PROGRESS missing start hours is invalid", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "IN_PROGRESS",
      meterType: "ENGINE_HOURS",
      startedAt: "2026-02-01T07:00",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("startEngineHours"))).toBe(true);
    }
  });

  test("end engine-hours below start is rejected (flags endEngineHours)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "COMPLETED",
      meterType: "ENGINE_HOURS",
      ...COMPLETED_TIMING,
      startEngineHours: "2500.0",
      endEngineHours: "2400.0",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("endEngineHours"))).toBe(true);
    }
  });

  test("a PLANNED trip needs no readings regardless of meter", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "PLANNED",
      meterType: "ENGINE_HOURS",
    });
    expect(result.success).toBe(true);
  });
});
