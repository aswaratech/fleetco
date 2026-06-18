import { describe, expect, test } from "vitest";

import {
  CreateServiceRecordFormSchema,
  UpdateServiceRecordFormSchema,
  hoursToTenths,
  tenthsToHoursInput,
} from "../src/lib/service-records-schema";

/**
 * Pins the web-side ServiceRecord form helpers (ADR-0037 / Program B, B5),
 * which shipped without their own unit test — the B6 close-out gap. A
 * ServiceRecord is a completed service event (the maintenance history). The
 * boundaries worth pinning are the two meter-reading validators — `odometerKm`
 * (integer km) and `engineHours` (decimal hours, the integer-tenths boundary
 * ADR-0036 owns) — plus the required-on-create / optional-on-update
 * `performedAt` date and the diff-PATCH shape. The schedule↔vehicle and
 * expense↔vehicle consistency rules (c5/c6) need DB lookups and live at the API
 * service layer (covered by `apps/api/test/service-records.service.test.ts`),
 * so they are deliberately out of scope here.
 */

// Typed structurally over just the bits used here (rather than via a zod
// export, whose names shift between major versions).
interface FormIssue {
  path: readonly PropertyKey[];
  message: string;
}
interface SafeParseLike {
  success: boolean;
  error?: { issues: readonly FormIssue[] };
}
function issueFor(result: SafeParseLike, path: string): FormIssue | undefined {
  return result.error?.issues.find((i) => i.path[0] === path);
}

// A valid create payload (vehicleId + performedAt are the only required fields);
// each test overrides only the field under test. Every value is a DOM string.
function createInput(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    vehicleId: "clvehicle0000000000000000",
    performedAt: "2026-02-01",
    ...overrides,
  };
}

describe("CreateServiceRecordFormSchema — required fields", () => {
  test("accepts the minimal valid record (vehicleId + performedAt, no meter readings)", () => {
    expect(CreateServiceRecordFormSchema.safeParse(createInput()).success).toBe(true);
  });

  test("accepts the optional links + readings + notes when present", () => {
    expect(
      CreateServiceRecordFormSchema.safeParse(
        createInput({
          serviceScheduleId: "clschedule00000000000000",
          expenseLogId: "clexpense000000000000000",
          odometerKm: "52000",
          engineHours: "1234.5",
          notes: "Replaced oil + filters",
        }),
      ).success,
    ).toBe(true);
  });

  test("rejects a missing vehicle on the vehicleId path", () => {
    const result = CreateServiceRecordFormSchema.safeParse(createInput({ vehicleId: "" }));
    expect(issueFor(result, "vehicleId")?.message).toMatch(/Pick a vehicle/);
  });

  test("rejects an empty performedAt (a completed service happened at a known time)", () => {
    const result = CreateServiceRecordFormSchema.safeParse(createInput({ performedAt: "" }));
    expect(issueFor(result, "performedAt")).toBeDefined();
  });

  test("rejects a malformed performedAt date", () => {
    const result = CreateServiceRecordFormSchema.safeParse(
      createInput({ performedAt: "01-02-2026" }),
    );
    expect(issueFor(result, "performedAt")?.message).toMatch(/YYYY-MM-DD/);
  });
});

describe("CreateServiceRecordFormSchema — odometer meter-reading validator (integer km)", () => {
  test("accepts a whole-kilometre reading", () => {
    expect(
      CreateServiceRecordFormSchema.safeParse(createInput({ odometerKm: "52000" })).success,
    ).toBe(true);
  });

  test("rejects a fractional reading (odometer is whole km)", () => {
    const result = CreateServiceRecordFormSchema.safeParse(createInput({ odometerKm: "52000.5" }));
    expect(issueFor(result, "odometerKm")?.message).toMatch(/whole number/);
  });

  test("rejects a negative reading (a reading is non-negative)", () => {
    const result = CreateServiceRecordFormSchema.safeParse(createInput({ odometerKm: "-1" }));
    expect(issueFor(result, "odometerKm")?.message).toMatch(/0 or greater/);
  });

  test("rejects a non-numeric reading", () => {
    const result = CreateServiceRecordFormSchema.safeParse(createInput({ odometerKm: "lots" }));
    expect(issueFor(result, "odometerKm")?.message).toMatch(/must be a number/);
  });

  test("an omitted reading is valid (the reading is optional on a record)", () => {
    expect(CreateServiceRecordFormSchema.safeParse(createInput()).success).toBe(true);
  });
});

describe("CreateServiceRecordFormSchema — engine-hours meter-reading validator (decimal hours)", () => {
  test("accepts a one-decimal hours reading (the 0.1 h hour-meter resolution)", () => {
    expect(
      CreateServiceRecordFormSchema.safeParse(createInput({ engineHours: "1234.5" })).success,
    ).toBe(true);
  });

  test("accepts a whole-number hours reading", () => {
    expect(
      CreateServiceRecordFormSchema.safeParse(createInput({ engineHours: "600" })).success,
    ).toBe(true);
  });

  test("rejects a two-decimal hours reading (over the one-decimal budget)", () => {
    const result = CreateServiceRecordFormSchema.safeParse(createInput({ engineHours: "12.34" }));
    expect(issueFor(result, "engineHours")?.message).toMatch(/at most 1 decimal place/);
  });

  test("rejects a negative hours reading", () => {
    const result = CreateServiceRecordFormSchema.safeParse(createInput({ engineHours: "-0.1" }));
    expect(issueFor(result, "engineHours")?.message).toMatch(/0 or greater/);
  });

  test("enforces the hours ceiling (10,000,000 h)", () => {
    const result = CreateServiceRecordFormSchema.safeParse(
      createInput({ engineHours: "10000001" }),
    );
    expect(issueFor(result, "engineHours")?.message).toMatch(/10000000 or less/);
  });
});

describe("UpdateServiceRecordFormSchema — diff-PATCH shape", () => {
  test("an empty patch is valid (every mutable field optional)", () => {
    expect(UpdateServiceRecordFormSchema.safeParse({}).success).toBe(true);
  });

  test("performedAt is optional on update (unlike create)", () => {
    expect(UpdateServiceRecordFormSchema.safeParse({ notes: "Re-keyed invoice" }).success).toBe(
      true,
    );
  });

  test("still validates the meter readings on update", () => {
    expect(
      issueFor(UpdateServiceRecordFormSchema.safeParse({ odometerKm: "52000.5" }), "odometerKm")
        ?.message,
    ).toMatch(/whole number/);
    expect(
      issueFor(UpdateServiceRecordFormSchema.safeParse({ engineHours: "1.234" }), "engineHours")
        ?.message,
    ).toMatch(/at most 1 decimal place/);
  });
});

describe("re-exported engine-hours converters are wired correctly", () => {
  test("hoursToTenths / tenthsToHoursInput round-trip the integer-tenths boundary", () => {
    // The action layer converts the decimal-hours form value to integer tenths
    // for the wire via this re-export (the odometer reading needs no conversion).
    expect(hoursToTenths(1234.5)).toBe(12345);
    expect(tenthsToHoursInput(12345)).toBe("1234.5");
    expect(hoursToTenths(Number(tenthsToHoursInput(12345)))).toBe(12345);
  });
});
