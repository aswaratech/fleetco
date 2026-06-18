import { describe, expect, test } from "vitest";

import {
  CreateServiceScheduleFormSchema,
  UpdateServiceScheduleFormSchema,
  formatIntervalLabel,
  intervalUnitLabel,
  intervalValueToInput,
  intervalValueToMinorUnits,
  type ServiceIntervalTypeName,
} from "../src/lib/service-schedules-schema";

/**
 * Pins the web-side ServiceSchedule form helpers (ADR-0037 / Program B, B5),
 * which shipped without their own unit test — the B6 close-out gap. The
 * load-bearing detail this module owns is THE INTERVAL REPRESENTATION (ADR-0037
 * c2): a schedule's `intervalValue` is one integer in the dimension's MINOR
 * UNITS, fixed by `intervalType` — km for DISTANCE_KM, days for CALENDAR_DAYS,
 * and integer TENTHS of an hour for ENGINE_HOURS (never a float). These tests
 * cover that conversion round-trip, the human-readable label, the per-type
 * bounds / decimal-budget validation (via `CreateServiceScheduleFormSchema`,
 * which is where `checkIntervalValue` actually runs), and the anchor-field
 * validators. The API stays authoritative; these are the inline-feedback
 * mirror, so the coverage is on the conversion + bounds boundaries that would
 * silently rot, not exhaustive parsing.
 */

// A safeParse issue on a named path, or undefined if the field is clean. Lets
// each assertion say "this field carries this complaint" without re-deriving
// the issue array each time. Typed structurally (rather than via a zod export,
// whose names shift between major versions) over just the bits used here.
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

// A valid create payload; each test overrides only the field under test. Every
// value is a string (the DOM shape RHF binds); the action layer converts.
function createInput(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    vehicleId: "clvehicle0000000000000000",
    name: "Oil change",
    intervalType: "DISTANCE_KM",
    intervalValue: "5000",
    status: "ACTIVE",
    ...overrides,
  };
}

describe("intervalUnitLabel — the unit word shown beside the interval input", () => {
  test("maps each interval type to its human unit", () => {
    expect(intervalUnitLabel("DISTANCE_KM")).toBe("km");
    expect(intervalUnitLabel("ENGINE_HOURS")).toBe("hours");
    expect(intervalUnitLabel("CALENDAR_DAYS")).toBe("days");
  });
});

describe("intervalValueToMinorUnits / intervalValueToInput round-trip", () => {
  test("DISTANCE_KM is a plain integer (km map 1:1 to the stored minor unit)", () => {
    expect(intervalValueToMinorUnits("DISTANCE_KM", 5000)).toBe(5000);
    expect(intervalValueToInput("DISTANCE_KM", 5000)).toBe("5000");
  });

  test("CALENDAR_DAYS is a plain integer (days map 1:1)", () => {
    expect(intervalValueToMinorUnits("CALENDAR_DAYS", 90)).toBe(90);
    expect(intervalValueToInput("CALENDAR_DAYS", 90)).toBe("90");
  });

  test("ENGINE_HOURS converts decimal hours ↔ integer tenths (250 h ⇄ 2500)", () => {
    // The load-bearing case: the operator types decimal hours; the wire stores
    // integer tenths, never a float (the FuelLog.litersMl precedent, ADR-0036).
    expect(intervalValueToMinorUnits("ENGINE_HOURS", 250)).toBe(2500);
    expect(intervalValueToInput("ENGINE_HOURS", 2500)).toBe("250.0");
    // A fractional reading at the hour-meter's native 0.1 h resolution.
    expect(intervalValueToMinorUnits("ENGINE_HOURS", 123.5)).toBe(1235);
    expect(intervalValueToInput("ENGINE_HOURS", 1235)).toBe("123.5");
  });

  test("the edit-form pre-fill (minor → input → minor) composes to the identity", () => {
    // tenthsToHoursInput then hoursToTenths must round-trip so an untouched
    // hours field is a no-op diff on PATCH.
    for (const minorUnits of [2500, 1235, 10, 0 + 1]) {
      const back = intervalValueToMinorUnits(
        "ENGINE_HOURS",
        Number(intervalValueToInput("ENGINE_HOURS", minorUnits)),
      );
      expect(back).toBe(minorUnits);
    }
  });
});

describe("formatIntervalLabel — the 'Every N <unit>' label the maintenance pages render", () => {
  test("DISTANCE_KM reuses formatKm (Indian-grouped, ' km' suffix)", () => {
    expect(formatIntervalLabel("DISTANCE_KM", 5000)).toBe("Every 5,000 km");
  });

  test("ENGINE_HOURS reuses formatHours (one decimal, ' h' suffix)", () => {
    expect(formatIntervalLabel("ENGINE_HOURS", 2500)).toBe("Every 250.0 h");
  });

  test("CALENDAR_DAYS pluralizes 'day' correctly", () => {
    expect(formatIntervalLabel("CALENDAR_DAYS", 90)).toBe("Every 90 days");
    expect(formatIntervalLabel("CALENDAR_DAYS", 1)).toBe("Every 1 day");
  });
});

describe("CreateServiceScheduleFormSchema — per-type interval bounds / decimal budget (checkIntervalValue)", () => {
  test("accepts a well-formed schedule of each interval type", () => {
    expect(CreateServiceScheduleFormSchema.safeParse(createInput()).success).toBe(true);
    expect(
      CreateServiceScheduleFormSchema.safeParse(
        createInput({ intervalType: "ENGINE_HOURS", intervalValue: "250.0" }),
      ).success,
    ).toBe(true);
    expect(
      CreateServiceScheduleFormSchema.safeParse(
        createInput({ intervalType: "CALENDAR_DAYS", intervalValue: "90" }),
      ).success,
    ).toBe(true);
  });

  test("DISTANCE_KM / CALENDAR_DAYS reject a decimal (whole-number only)", () => {
    for (const intervalType of ["DISTANCE_KM", "CALENDAR_DAYS"] as const) {
      const result = CreateServiceScheduleFormSchema.safeParse(
        createInput({ intervalType, intervalValue: "5000.5" }),
      );
      expect(issueFor(result, "intervalValue")?.message).toMatch(/whole number/);
    }
  });

  test("ENGINE_HOURS accepts one decimal but rejects two (the 0.1 h meter resolution)", () => {
    expect(
      CreateServiceScheduleFormSchema.safeParse(
        createInput({ intervalType: "ENGINE_HOURS", intervalValue: "250.5" }),
      ).success,
    ).toBe(true);
    const tooPrecise = CreateServiceScheduleFormSchema.safeParse(
      createInput({ intervalType: "ENGINE_HOURS", intervalValue: "250.55" }),
    );
    expect(issueFor(tooPrecise, "intervalValue")?.message).toMatch(/at most 1 decimal place/);
  });

  test("a non-numeric interval value is rejected on the intervalValue path", () => {
    const result = CreateServiceScheduleFormSchema.safeParse(
      createInput({ intervalValue: "soon" }),
    );
    expect(issueFor(result, "intervalValue")?.message).toMatch(/must be a number/);
  });

  test("enforces the per-type floor (km/days ≥ 1, hours ≥ 0.1)", () => {
    expect(
      issueFor(
        CreateServiceScheduleFormSchema.safeParse(createInput({ intervalValue: "0" })),
        "intervalValue",
      )?.message,
    ).toMatch(/1 or greater/);
    expect(
      issueFor(
        CreateServiceScheduleFormSchema.safeParse(
          createInput({ intervalType: "ENGINE_HOURS", intervalValue: "0" }),
        ),
        "intervalValue",
      )?.message,
    ).toMatch(/0\.1 or greater/);
  });

  test("enforces the ceiling (100,000,000 km/days; 10,000,000 h)", () => {
    expect(
      issueFor(
        CreateServiceScheduleFormSchema.safeParse(createInput({ intervalValue: "100000001" })),
        "intervalValue",
      )?.message,
    ).toMatch(/100000000 or less/);
    expect(
      issueFor(
        CreateServiceScheduleFormSchema.safeParse(
          createInput({ intervalType: "ENGINE_HOURS", intervalValue: "10000001" }),
        ),
        "intervalValue",
      )?.message,
    ).toMatch(/10000000 or less/);
  });

  test("an empty interval value is the required-field error, not a bounds error", () => {
    const result = CreateServiceScheduleFormSchema.safeParse(createInput({ intervalValue: "" }));
    expect(issueFor(result, "intervalValue")?.message).toMatch(/required/);
  });
});

describe("CreateServiceScheduleFormSchema — last-service anchor validators", () => {
  test("a valid anchor (odometer integer, hours one-decimal) passes", () => {
    expect(
      CreateServiceScheduleFormSchema.safeParse(
        createInput({ lastServiceOdometerKm: "42000", lastServiceEngineHours: "1234.5" }),
      ).success,
    ).toBe(true);
  });

  test("omitted anchors are valid (the API seeds them from the vehicle's reading, c4)", () => {
    // The base input supplies no anchor fields at all — they are optional.
    expect(CreateServiceScheduleFormSchema.safeParse(createInput()).success).toBe(true);
  });

  test("a fractional odometer reading is rejected on its own path", () => {
    const result = CreateServiceScheduleFormSchema.safeParse(
      createInput({ lastServiceOdometerKm: "42000.5" }),
    );
    expect(issueFor(result, "lastServiceOdometerKm")?.message).toMatch(/whole number/);
  });

  test("a two-decimal hours anchor is rejected on its own path", () => {
    const result = CreateServiceScheduleFormSchema.safeParse(
      createInput({ lastServiceEngineHours: "12.34" }),
    );
    expect(issueFor(result, "lastServiceEngineHours")?.message).toMatch(/at most 1 decimal place/);
  });

  test("a negative anchor is rejected (readings are non-negative; a new asset reads 0)", () => {
    expect(
      issueFor(
        CreateServiceScheduleFormSchema.safeParse(createInput({ lastServiceOdometerKm: "-1" })),
        "lastServiceOdometerKm",
      )?.message,
    ).toMatch(/0 or greater/);
  });

  test("a malformed lastServiceAt date is rejected", () => {
    const result = CreateServiceScheduleFormSchema.safeParse(
      createInput({ lastServiceAt: "01-02-2026" }),
    );
    expect(issueFor(result, "lastServiceAt")?.message).toMatch(/YYYY-MM-DD/);
  });
});

describe("UpdateServiceScheduleFormSchema — diff-PATCH shape + per-type re-validation", () => {
  test("an empty patch is valid (every field optional)", () => {
    expect(UpdateServiceScheduleFormSchema.safeParse({}).success).toBe(true);
  });

  test("re-validates the interval value against whatever intervalType the diff carries", () => {
    // A two-decimal value is fine for ENGINE_HOURS' one-decimal budget only when
    // it has one decimal; "250.55" is over budget and must be flagged.
    expect(
      UpdateServiceScheduleFormSchema.safeParse({
        intervalType: "ENGINE_HOURS",
        intervalValue: "250.5",
      }).success,
    ).toBe(true);
    const result = UpdateServiceScheduleFormSchema.safeParse({
      intervalType: "ENGINE_HOURS",
      intervalValue: "250.55",
    });
    expect(issueFor(result, "intervalValue")?.message).toMatch(/at most 1 decimal place/);
  });

  test("a touched-but-blank interval value is left to the API (no in-form bounds error)", () => {
    // The superRefine skips an empty intervalValue: a diff-PATCH that does not
    // touch the interval should not invent a bounds complaint.
    const types = ["DISTANCE_KM", "ENGINE_HOURS", "CALENDAR_DAYS"] as ServiceIntervalTypeName[];
    for (const intervalType of types) {
      expect(
        UpdateServiceScheduleFormSchema.safeParse({ intervalType, intervalValue: "" }).success,
      ).toBe(true);
    }
  });

  test("still validates the anchor fields on update", () => {
    const result = UpdateServiceScheduleFormSchema.safeParse({ lastServiceEngineHours: "1.234" });
    expect(issueFor(result, "lastServiceEngineHours")?.message).toMatch(/at most 1 decimal place/);
  });
});
