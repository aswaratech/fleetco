import { describe, expect, test } from "vitest";

import {
  collectDocumentExpiryReminders,
  SUBJECT_TYPE_DOCUMENT,
  type DocumentReminderInput,
} from "../src/modules/notifications/documents-source";

// Pure unit tests for the DOCUMENT reminder source (ADR-0049 c5). No DB, no
// clock — `now`/`windowDays` are explicit, like the compliance-source test.
// Pins: the shared-classifier states, the subject-label shape, the category →
// kindLabel mapping, and — the load-bearing one — the vehicle-compliance-
// category EXCLUSION (a vehicle-attached bluebook/insurance/permit document
// yields NO item, so one lapse never double-emails against the structured
// compliance field).

// A fixed reference instant; the fixtures below are relative to it.
const NOW = new Date("2026-06-01T00:00:00.000Z");

function doc(overrides: Partial<DocumentReminderInput> = {}): DocumentReminderInput {
  return {
    id: "d1",
    category: "AGREEMENT",
    title: "Haul contract 2083",
    // 15 days before NOW → expired.
    expiresAt: "2026-05-17T00:00:00.000Z",
    entityLabel: "Himalayan Builders Pvt. Ltd.",
    vehicleAttached: false,
    ...overrides,
  };
}

describe("collectDocumentExpiryReminders (ADR-0049 c5)", () => {
  test("classifies an expired customer agreement into a DOCUMENT reminder item", () => {
    const items = collectDocumentExpiryReminders([doc()], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      subjectType: SUBJECT_TYPE_DOCUMENT,
      subjectId: "d1",
      subjectLabel: "Haul contract 2083 — Himalayan Builders Pvt. Ltd.",
      reminderKind: "AGREEMENT",
      kindLabel: "Agreement",
      state: "expired",
      occurrenceKey: "2026-05-17T00:00:00.000Z",
    });
  });

  test("classifies an expiring-soon document (within the 30-day window)", () => {
    // 20 days AFTER now → expiring-soon.
    const items = collectDocumentExpiryReminders(
      [doc({ expiresAt: "2026-06-21T00:00:00.000Z" })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("expiring-soon");
  });

  test("a document with no expiry, or one comfortably in the future, yields no item", () => {
    const items = collectDocumentExpiryReminders(
      [
        doc({ id: "d-null", expiresAt: null }),
        doc({ id: "d-far", expiresAt: "2027-01-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(items).toHaveLength(0);
  });

  test("maps every document category to its precise-noun kindLabel", () => {
    const cases: [string, string][] = [
      ["AGREEMENT", "Agreement"],
      ["LICENSE", "License"],
      ["ID_DOCUMENT", "ID document"],
      ["OTHER", "Document"],
      ["BLUEBOOK", "Bluebook"],
      ["INSURANCE", "Insurance"],
      ["ROUTE_PERMIT", "Route permit"],
    ];
    for (const [category, label] of cases) {
      // Driver-attached so the compliance categories are NOT excluded here.
      const items = collectDocumentExpiryReminders(
        [doc({ category, vehicleAttached: false })],
        NOW,
      );
      expect(items[0].kindLabel).toBe(label);
    }
  });

  // The load-bearing exclusion (ADR-0049 c5) --------------------------------

  test("EXCLUDES a vehicle-attached bluebook/insurance/permit document (no double-email)", () => {
    const excluded = collectDocumentExpiryReminders(
      [
        doc({ id: "vb", category: "BLUEBOOK", vehicleAttached: true }),
        doc({ id: "vi", category: "INSURANCE", vehicleAttached: true }),
        doc({ id: "vp", category: "ROUTE_PERMIT", vehicleAttached: true }),
      ],
      NOW,
    );
    // The Vehicle's structured *ExpiresAt fields are canonical — the compliance
    // source owns these lapses; the document source stays silent.
    expect(excluded).toHaveLength(0);
  });

  test("still reminds on a vehicle-attached AGREEMENT / OTHER document (no structured twin)", () => {
    const items = collectDocumentExpiryReminders(
      [
        doc({ id: "va", category: "AGREEMENT", vehicleAttached: true }),
        doc({ id: "vo", category: "OTHER", vehicleAttached: true }),
      ],
      NOW,
    );
    expect(items.map((i) => i.subjectId).sort()).toEqual(["va", "vo"]);
  });

  test("does NOT exclude a DRIVER/CUSTOMER document even in a compliance category", () => {
    // A driver's document is never vehicleAttached, so the exclusion (which is
    // vehicle-scoped) never touches it — it has no structured Vehicle twin.
    const items = collectDocumentExpiryReminders(
      [doc({ id: "dl", category: "INSURANCE", vehicleAttached: false })],
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].subjectId).toBe("dl");
  });

  test("an unknown category degrades to its raw token as the kindLabel", () => {
    const items = collectDocumentExpiryReminders(
      [doc({ category: "FUTURE_KIND", vehicleAttached: false })],
      NOW,
    );
    expect(items[0].kindLabel).toBe("FUTURE_KIND");
  });
});
