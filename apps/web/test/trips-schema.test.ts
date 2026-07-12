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

/**
 * Pins the OFFERED-order client-side cross-field rule (ADR-0047 c3). Dispatching
 * a trip = saving it as OFFERED with a driver, a vehicle, and the order; the form
 * must require material + pickup + drop-off at OFFERED (mirroring the API's
 * authoritative rule), validate the material against the MaterialType enum, and
 * require the free-text note when the material is "Other". The order is
 * unconstrained before OFFERED — a PLANNED draft carries whatever is filled.
 */
describe("CreateTripFormSchema OFFERED-order cross-field (ADR-0047 c3)", () => {
  const OFFERED_BASE = { ...BASE, status: "OFFERED", meterType: "ODOMETER_KM" };
  const FULL_ORDER = {
    materialType: "SAND",
    pickupSiteId: "site_pickup",
    dropoffSiteId: "site_drop",
  };

  test("OFFERED with material + pickup + drop-off is valid (no meter reading needed)", () => {
    const result = CreateTripFormSchema.safeParse({ ...OFFERED_BASE, ...FULL_ORDER });
    expect(result.success).toBe(true);
  });

  test("OFFERED missing material is invalid (flags materialType)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...OFFERED_BASE,
      pickupSiteId: "site_pickup",
      dropoffSiteId: "site_drop",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("materialType"))).toBe(true);
    }
  });

  test("OFFERED missing pickup site is invalid (flags pickupSiteId)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...OFFERED_BASE,
      materialType: "SAND",
      dropoffSiteId: "site_drop",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("pickupSiteId"))).toBe(true);
    }
  });

  test("OFFERED missing drop-off site is invalid (flags dropoffSiteId)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...OFFERED_BASE,
      materialType: "SAND",
      pickupSiteId: "site_pickup",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("dropoffSiteId"))).toBe(true);
    }
  });

  test("material OTHER without a note is invalid (flags materialNote)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...OFFERED_BASE,
      materialType: "OTHER",
      pickupSiteId: "site_pickup",
      dropoffSiteId: "site_drop",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("materialNote"))).toBe(true);
    }
  });

  test("material OTHER with a note is valid", () => {
    const result = CreateTripFormSchema.safeParse({
      ...OFFERED_BASE,
      materialType: "OTHER",
      materialNote: "Crushed concrete",
      pickupSiteId: "site_pickup",
      dropoffSiteId: "site_drop",
    });
    expect(result.success).toBe(true);
  });

  test("a PLANNED draft with material OTHER but no note is valid (the note is required only at OFFERED)", () => {
    // Guards the fix for the over-constraint the note rule once had: it must not
    // block a pre-dispatch draft (or an externally-created OFFERED-Other trip's
    // later edit), only require the note at the OFFERED dispatch gate.
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "PLANNED",
      meterType: "ODOMETER_KM",
      materialType: "OTHER",
    });
    expect(result.success).toBe(true);
  });

  test("an unknown material value is rejected (the MaterialType enum guard)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...OFFERED_BASE,
      materialType: "PLUTONIUM",
      pickupSiteId: "site_pickup",
      dropoffSiteId: "site_drop",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("materialType"))).toBe(true);
    }
  });

  test("a PLANNED draft needs no order (it is required only at OFFERED)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "PLANNED",
      meterType: "ODOMETER_KM",
    });
    expect(result.success).toBe(true);
  });

  test("an ACCEPTED trip is not re-gated on the order (only OFFERED gates it, mirroring the API)", () => {
    const result = CreateTripFormSchema.safeParse({
      ...BASE,
      status: "ACCEPTED",
      meterType: "ODOMETER_KM",
    });
    expect(result.success).toBe(true);
  });
});
