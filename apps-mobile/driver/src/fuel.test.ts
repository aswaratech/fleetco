import { describe, expect, it } from "@jest/globals";

import { fuelLogPayload, litersToMl, previewTotalCostPaisa, rupeesToPaisa } from "./fuel";

describe("litersToMl", () => {
  it("converts whole and fractional liters to integer milliliters", () => {
    expect(litersToMl(12.5)).toBe(12500);
    expect(litersToMl(12.345)).toBe(12345);
    expect(litersToMl(0.001)).toBe(1);
  });

  it("rounds a sub-milliliter fourth decimal half-up", () => {
    expect(litersToMl(12.3456)).toBe(12346);
  });
});

describe("rupeesToPaisa", () => {
  it("converts whole and fractional rupees to integer paisa", () => {
    expect(rupeesToPaisa(150.75)).toBe(15075);
    expect(rupeesToPaisa(145.5)).toBe(14550);
  });

  it("rounds a sub-paisa third decimal half-up", () => {
    expect(rupeesToPaisa(150.756)).toBe(15076);
    expect(rupeesToPaisa(150.754)).toBe(15075);
  });
});

describe("previewTotalCostPaisa", () => {
  it("matches the server's derivation (round(litersMl * pricePerLiterPaisa / 1000))", () => {
    // 12.5 L @ NPR 145.50 → 12500 mL × 14550 paisa/L ÷ 1000 = 181875 paisa (NPR 1818.75).
    expect(previewTotalCostPaisa(12.5, 145.5)).toBe(181875);
  });

  it("returns null when either input is missing or not finite", () => {
    expect(previewTotalCostPaisa(null, 145.5)).toBeNull();
    expect(previewTotalCostPaisa(12.5, null)).toBeNull();
    expect(previewTotalCostPaisa(Number.NaN, 145.5)).toBeNull();
  });
});

describe("fuelLogPayload", () => {
  const nowIso = "2026-06-17T06:00:00.000Z";

  it("builds the POST body, converting decimals to integer mL / paisa and stamping the date", () => {
    expect(
      fuelLogPayload({ vehicleId: "v1", tripId: "t1", liters: 12.5, pricePerLiter: 145.5 }, nowIso),
    ).toEqual({
      vehicleId: "v1",
      tripId: "t1",
      date: nowIso,
      litersMl: 12500,
      pricePerLiterPaisa: 14550,
    });
  });

  it("includes odometerReadingKm when an odometer reading is supplied", () => {
    expect(
      fuelLogPayload(
        { vehicleId: "v1", tripId: "t1", liters: 10, pricePerLiter: 100, odometerKm: 45000 },
        nowIso,
      ),
    ).toEqual({
      vehicleId: "v1",
      tripId: "t1",
      date: nowIso,
      litersMl: 10000,
      pricePerLiterPaisa: 10000,
      odometerReadingKm: 45000,
    });
  });

  it("omits the odometerReadingKm key entirely when no reading is supplied", () => {
    const payload = fuelLogPayload(
      { vehicleId: "v1", tripId: "t1", liters: 10, pricePerLiter: 100 },
      nowIso,
    );
    expect(payload).not.toHaveProperty("odometerReadingKm");
  });
});
