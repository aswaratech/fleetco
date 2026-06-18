import { describe, expect, it } from "@jest/globals";

import {
  hoursToTenths,
  isStartable,
  isStoppable,
  meterIncludesHours,
  meterIncludesOdometer,
  tripStartPayload,
  tripStopPayload,
  type DriverTrip,
  type MeterType,
} from "./trips";

describe("tripStartPayload", () => {
  it("builds an odometer-only start (km-metered vehicle)", () => {
    expect(tripStartPayload({ odometerKm: 80000 }, "2026-06-16T06:00:00.000Z")).toEqual({
      status: "IN_PROGRESS",
      startedAt: "2026-06-16T06:00:00.000Z",
      startOdometerKm: 80000,
    });
  });

  it("builds an hours-only start (ENGINE_HOURS vehicle), converting hours to tenths", () => {
    expect(tripStartPayload({ engineHours: 2500 }, "2026-06-16T06:00:00.000Z")).toEqual({
      status: "IN_PROGRESS",
      startedAt: "2026-06-16T06:00:00.000Z",
      startEngineHours: 25000,
    });
  });

  it("builds a both-meter start (BOTH vehicle) with km and tenths", () => {
    expect(
      tripStartPayload({ odometerKm: 80000, engineHours: 1000.5 }, "2026-06-16T06:00:00.000Z"),
    ).toEqual({
      status: "IN_PROGRESS",
      startedAt: "2026-06-16T06:00:00.000Z",
      startOdometerKm: 80000,
      startEngineHours: 10005,
    });
  });
});

describe("tripStopPayload", () => {
  it("builds an odometer-only stop (km-metered vehicle)", () => {
    expect(tripStopPayload({ odometerKm: 80250 }, "2026-06-16T14:00:00.000Z")).toEqual({
      status: "COMPLETED",
      endedAt: "2026-06-16T14:00:00.000Z",
      endOdometerKm: 80250,
    });
  });

  it("builds an hours-only stop (ENGINE_HOURS vehicle), converting hours to tenths", () => {
    expect(tripStopPayload({ engineHours: 2509.5 }, "2026-06-16T14:00:00.000Z")).toEqual({
      status: "COMPLETED",
      endedAt: "2026-06-16T14:00:00.000Z",
      endEngineHours: 25095,
    });
  });

  it("omits a meter key entirely when its reading is not supplied", () => {
    // The screen passes only the reading(s) the vehicle's meterType calls for,
    // so an ODOMETER_KM stop never carries an engineHours key (the API .strict()
    // would still accept null, but omitting keeps the body minimal + honest).
    const payload = tripStopPayload({ odometerKm: 80250 }, "2026-06-16T14:00:00.000Z");
    expect("endEngineHours" in payload).toBe(false);
  });
});

describe("hoursToTenths", () => {
  it("converts decimal hours to integer tenths (half-up), matching the wire unit", () => {
    expect(hoursToTenths(2500)).toBe(25000);
    expect(hoursToTenths(2509.5)).toBe(25095);
    expect(hoursToTenths(0)).toBe(0);
  });
});

describe("meterIncludesOdometer / meterIncludesHours", () => {
  const cases: { meter: MeterType; odo: boolean; hours: boolean }[] = [
    { meter: "ODOMETER_KM", odo: true, hours: false },
    { meter: "ENGINE_HOURS", odo: false, hours: true },
    { meter: "BOTH", odo: true, hours: true },
  ];
  for (const c of cases) {
    it(`${c.meter}: odometer=${c.odo}, hours=${c.hours}`, () => {
      expect(meterIncludesOdometer(c.meter)).toBe(c.odo);
      expect(meterIncludesHours(c.meter)).toBe(c.hours);
    });
  }
});

describe("isStartable / isStoppable", () => {
  const trip = (status: DriverTrip["status"]): DriverTrip => ({
    id: "t1",
    status,
    vehicle: { id: "v1", registrationNumber: "BA 1 KA 1234", meterType: "ODOMETER_KM" },
  });

  it("a PLANNED trip is startable, not stoppable", () => {
    expect(isStartable(trip("PLANNED"))).toBe(true);
    expect(isStoppable(trip("PLANNED"))).toBe(false);
  });

  it("an IN_PROGRESS trip is stoppable, not startable", () => {
    expect(isStartable(trip("IN_PROGRESS"))).toBe(false);
    expect(isStoppable(trip("IN_PROGRESS"))).toBe(true);
  });

  it("a COMPLETED trip is neither startable nor stoppable", () => {
    expect(isStartable(trip("COMPLETED"))).toBe(false);
    expect(isStoppable(trip("COMPLETED"))).toBe(false);
  });
});
