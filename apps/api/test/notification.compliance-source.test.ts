import { describe, expect, test } from "vitest";

import {
  collectVehicleComplianceReminders,
  notificationDedupKey,
  type ComplianceVehicle,
} from "../src/modules/notifications/compliance-source";
import { combineRecipients } from "../src/modules/notifications/notification.service";

// Pure unit tests for the compliance reminder SOURCE and the recipient combine
// (ADR-0038 c5–c7). No DB / network / clock: `now` is explicit. The
// classification delegates to the SHARED complianceBadgeState (ADR-0038 c6), so
// these tests pin the source's behavior — which kinds become items, the dedup
// key, and recipient resolution — not the boundary math (the shared
// compliance.test.ts owns that).

// now = 2026-05-25 (UTC). Relative expiries below land deterministically:
//   2026-05-20 → expired (5 days past); 2026-06-10 → expiring-soon (16 days,
//   within the 30-day window); 2026-08-01 → ok (68 days out).
const NOW = new Date("2026-05-25T12:00:00.000Z");

function vehicle(overrides: Partial<ComplianceVehicle> = {}): ComplianceVehicle {
  return {
    id: "v1",
    registrationNumber: "BA 2 KHA 1234",
    bluebookExpiresAt: null,
    insuranceExpiresAt: null,
    routePermitExpiresAt: null,
    ...overrides,
  };
}

describe("collectVehicleComplianceReminders (ADR-0038 C2 c6)", () => {
  test("an expired document produces one expired item carrying the expiry as occurrenceKey", () => {
    const items = collectVehicleComplianceReminders(
      [vehicle({ bluebookExpiresAt: "2026-05-20T00:00:00.000Z" })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      subjectType: "VEHICLE",
      subjectId: "v1",
      subjectLabel: "BA 2 KHA 1234",
      reminderKind: "BLUEBOOK",
      kindLabel: "Bluebook",
      state: "expired",
      occurrenceKey: "2026-05-20T00:00:00.000Z",
    });
  });

  test("an expiring-soon document produces one expiring-soon item", () => {
    const items = collectVehicleComplianceReminders(
      [vehicle({ insuranceExpiresAt: "2026-06-10T00:00:00.000Z" })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reminderKind: "INSURANCE", state: "expiring-soon" });
  });

  test("an ok (far-future) document produces no item", () => {
    const items = collectVehicleComplianceReminders(
      [vehicle({ routePermitExpiresAt: "2026-08-01T00:00:00.000Z" })],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  test("a null (never-scanned) expiry produces no item", () => {
    const items = collectVehicleComplianceReminders([vehicle({ bluebookExpiresAt: null })], NOW);
    expect(items).toHaveLength(0);
  });

  test("all three documents lapsing produce three items with the right kinds", () => {
    const items = collectVehicleComplianceReminders(
      [
        vehicle({
          bluebookExpiresAt: "2026-05-20T00:00:00.000Z",
          insuranceExpiresAt: "2026-06-10T00:00:00.000Z",
          routePermitExpiresAt: "2026-05-19T00:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(items.map((i) => i.reminderKind).sort()).toEqual([
      "BLUEBOOK",
      "INSURANCE",
      "ROUTE_PERMIT",
    ]);
  });

  test("scans multiple vehicles independently", () => {
    const items = collectVehicleComplianceReminders(
      [
        vehicle({
          id: "v1",
          registrationNumber: "BA 1",
          bluebookExpiresAt: "2026-05-20T00:00:00.000Z",
        }),
        vehicle({
          id: "v2",
          registrationNumber: "BA 2",
          insuranceExpiresAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].subjectId).toBe("v1");
  });
});

describe("notificationDedupKey (ADR-0038 C2 c5)", () => {
  const base = {
    subjectType: "VEHICLE",
    subjectId: "v1",
    reminderKind: "BLUEBOOK",
    state: "expired",
    occurrenceKey: "2026-05-20T00:00:00.000Z",
  };

  test("equal tuples produce equal keys", () => {
    expect(notificationDedupKey(base)).toBe(notificationDedupKey({ ...base }));
  });

  test("a different state produces a different key (expired vs expiring-soon distinct)", () => {
    expect(notificationDedupKey(base)).not.toBe(
      notificationDedupKey({ ...base, state: "expiring-soon" }),
    );
  });

  test("a different occurrenceKey produces a different key (a renewal re-arms)", () => {
    expect(notificationDedupKey(base)).not.toBe(
      notificationDedupKey({ ...base, occurrenceKey: "2027-05-20T00:00:00.000Z" }),
    );
  });
});

describe("combineRecipients (ADR-0038 C2 c7)", () => {
  test("returns the admin emails when no env override is set", () => {
    expect(combineRecipients(["admin@fleetco.test"], undefined)).toEqual(["admin@fleetco.test"]);
    expect(combineRecipients(["admin@fleetco.test"], "")).toEqual(["admin@fleetco.test"]);
  });

  test("adds the comma-separated env override, trimming whitespace", () => {
    expect(
      combineRecipients(["admin@fleetco.test"], " ops@fleetco.test , finance@fleetco.test "),
    ).toEqual(["admin@fleetco.test", "ops@fleetco.test", "finance@fleetco.test"]);
  });

  test("de-duplicates across the admin list and the override", () => {
    expect(
      combineRecipients(["admin@fleetco.test"], "admin@fleetco.test, ops@fleetco.test"),
    ).toEqual(["admin@fleetco.test", "ops@fleetco.test"]);
  });

  test("drops empty entries from a sloppy override string", () => {
    expect(combineRecipients([], "ops@fleetco.test,, ,finance@fleetco.test")).toEqual([
      "ops@fleetco.test",
      "finance@fleetco.test",
    ]);
  });
});
