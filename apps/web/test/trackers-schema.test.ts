import { describe, expect, test } from "vitest";

import {
  CreateTrackerFormSchema,
  TRACKER_STATUS_BADGE_VARIANTS,
  TRACKER_STATUS_LABELS,
  TRACKER_STATUS_OPTIONS,
  TRACKER_STATUSES,
  UpdateTrackerFormSchema,
} from "../src/lib/trackers-schema";

// Pure-function tests for the web-side tracker form schemas (ADR-0042 M4).
// The forms/pages ship untested-by-render (no jsdom harness — vitest
// collects only test/**/*.test.ts under the node env); all correctness
// lives in these schemas, which the create/edit forms use as resolvers and
// the server actions re-run as defense in depth. The API's authoritative
// mirror is pinned by apps/api/test/trackers.controller.test.ts.

const VALID = {
  imei: "352093081452811",
  label: "",
  simMsisdn: "",
  status: "SPARE",
  vehicleId: "",
  installedAt: "",
} as const;

describe("status display maps stay complete", () => {
  test("every status has an option, a label, and a badge variant", () => {
    expect(TRACKER_STATUS_OPTIONS.map((o) => o.value)).toEqual([...TRACKER_STATUSES]);
    for (const status of TRACKER_STATUSES) {
      expect(TRACKER_STATUS_LABELS[status]).toBeTruthy();
      expect(TRACKER_STATUS_BADGE_VARIANTS[status]).toBeTruthy();
    }
  });

  test("only ACTIVE carries a status hue (the label is the meaning, hue is recognition)", () => {
    expect(TRACKER_STATUS_BADGE_VARIANTS.ACTIVE).toBe("success");
    expect(TRACKER_STATUS_BADGE_VARIANTS.SPARE).toBe("neutral");
    expect(TRACKER_STATUS_BADGE_VARIANTS.RETIRED).toBe("neutral");
  });
});

describe("CreateTrackerFormSchema — the IMEI gate", () => {
  test("a valid 15-digit IMEI parses", () => {
    const parsed = CreateTrackerFormSchema.parse(VALID);
    expect(parsed.imei).toBe(VALID.imei);
  });

  test("surrounding whitespace is trimmed", () => {
    expect(CreateTrackerFormSchema.parse({ ...VALID, imei: " 352093081452811 " }).imei).toBe(
      "352093081452811",
    );
  });

  test.each([
    ["14 digits", "35209308145281"],
    ["16 digits", "3520930814528112"],
    ["separators", "35-2093-0814-5281"],
    ["letters", "35209308145281a"],
    ["empty", ""],
  ])("rejects %s", (_name, imei) => {
    expect(CreateTrackerFormSchema.safeParse({ ...VALID, imei }).success).toBe(false);
  });
});

describe("CreateTrackerFormSchema — field shapes", () => {
  test('empty optional fields parse ("" = not provided / unassigned)', () => {
    const parsed = CreateTrackerFormSchema.parse(VALID);
    expect(parsed.label).toBe("");
    expect(parsed.simMsisdn).toBe("");
    expect(parsed.vehicleId).toBe("");
    expect(parsed.installedAt).toBe("");
  });

  test("a Nepali MSISDN with +country and spaces parses; letters are rejected", () => {
    expect(
      CreateTrackerFormSchema.safeParse({ ...VALID, simMsisdn: "+977 9800000000" }).success,
    ).toBe(true);
    expect(CreateTrackerFormSchema.safeParse({ ...VALID, simMsisdn: "not-a-number" }).success).toBe(
      false,
    );
  });

  test("installedAt accepts YYYY-MM-DD and rejects other shapes", () => {
    expect(CreateTrackerFormSchema.safeParse({ ...VALID, installedAt: "2026-07-01" }).success).toBe(
      true,
    );
    expect(CreateTrackerFormSchema.safeParse({ ...VALID, installedAt: "01/07/2026" }).success).toBe(
      false,
    );
  });

  test("an unknown status is rejected", () => {
    expect(CreateTrackerFormSchema.safeParse({ ...VALID, status: "BROKEN" }).success).toBe(false);
  });
});

describe("the retirement invariant (RETIRED ⇒ unassigned), pinned to vehicleId", () => {
  test("RETIRED with a vehicle → invalid, error on the vehicleId path", () => {
    const result = CreateTrackerFormSchema.safeParse({
      ...VALID,
      status: "RETIRED",
      vehicleId: "cvehicle0000000000000tst",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "vehicleId")).toBe(true);
    }
  });

  test("RETIRED unassigned is valid; ACTIVE assigned is valid", () => {
    expect(CreateTrackerFormSchema.safeParse({ ...VALID, status: "RETIRED" }).success).toBe(true);
    expect(
      CreateTrackerFormSchema.safeParse({
        ...VALID,
        status: "ACTIVE",
        vehicleId: "cvehicle0000000000000tst",
      }).success,
    ).toBe(true);
  });
});

describe("UpdateTrackerFormSchema — per-field diffs", () => {
  test("single-field diffs parse (the edit form PATCHes only changed keys)", () => {
    expect(UpdateTrackerFormSchema.safeParse({ label: "relabeled" }).success).toBe(true);
    expect(UpdateTrackerFormSchema.safeParse({ vehicleId: "" }).success).toBe(true);
    expect(UpdateTrackerFormSchema.safeParse({ status: "RETIRED" }).success).toBe(true);
  });

  test("no cross-field lifecycle refine here — the merged shape is the API service's job", () => {
    // A status-only diff to RETIRED must pass the client schema even though
    // the tracker may still be assigned: only the service sees the merged
    // shape. (The FORM still warns early — its resolver is the full create
    // schema over the visible values.)
    expect(UpdateTrackerFormSchema.safeParse({ status: "RETIRED" }).success).toBe(true);
  });

  test("a bad imei in a diff is still rejected", () => {
    expect(UpdateTrackerFormSchema.safeParse({ imei: "123" }).success).toBe(false);
  });
});
