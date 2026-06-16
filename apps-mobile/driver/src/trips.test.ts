import { describe, expect, it } from "@jest/globals";

import { isStartable, isStoppable, tripStartPayload, tripStopPayload, type DriverTrip } from "./trips";

describe("tripStartPayload", () => {
  it("builds the PLANNED → IN_PROGRESS PATCH body from the supplied odometer + time", () => {
    expect(tripStartPayload(80000, "2026-06-16T06:00:00.000Z")).toEqual({
      status: "IN_PROGRESS",
      startedAt: "2026-06-16T06:00:00.000Z",
      startOdometerKm: 80000,
    });
  });
});

describe("tripStopPayload", () => {
  it("builds the IN_PROGRESS → COMPLETED PATCH body from the supplied odometer + time", () => {
    expect(tripStopPayload(80250, "2026-06-16T14:00:00.000Z")).toEqual({
      status: "COMPLETED",
      endedAt: "2026-06-16T14:00:00.000Z",
      endOdometerKm: 80250,
    });
  });
});

describe("isStartable / isStoppable", () => {
  const trip = (status: DriverTrip["status"]): DriverTrip => ({
    id: "t1",
    status,
    vehicle: { id: "v1", registrationNumber: "BA 1 KA 1234" },
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
