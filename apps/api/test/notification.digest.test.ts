import { describe, expect, test } from "vitest";

import { type ReminderItem } from "../src/modules/notifications/compliance-source";
import { renderComplianceDigest } from "../src/modules/notifications/digest";

// Pure unit tests for the reminder-digest renderer (ADR-0038 commitment 7). No
// DB, no network, no clock — like every FleetCo formatter test. Pins the §Voice
// register (no exclamation, precise nouns, state the fact), the Bikram-Sambat
// dates (via the shared formatNepaliDate), the expired-before-expiring-soon
// ordering, the mandatory plain-text body, and HTML escaping.

function item(overrides: Partial<ReminderItem> = {}): ReminderItem {
  return {
    subjectType: "VEHICLE",
    subjectId: "v1",
    subjectLabel: "BA 2 KHA 1234",
    reminderKind: "BLUEBOOK",
    kindLabel: "Bluebook",
    state: "expired",
    // 2026-05-20 converts to BS 2083 Jestha 6 (verified against the library).
    occurrenceKey: "2026-05-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderComplianceDigest (ADR-0038 C2 c7)", () => {
  test("subject states the count — singular for one item", () => {
    const { subject } = renderComplianceDigest([item()]);
    expect(subject).toBe("FleetCo — 1 item needs attention");
  });

  test("subject pluralises for several items", () => {
    const { subject } = renderComplianceDigest([
      item({ subjectId: "v1", reminderKind: "BLUEBOOK" }),
      item({ subjectId: "v2", reminderKind: "INSURANCE", kindLabel: "Insurance" }),
      item({ subjectId: "v3", reminderKind: "ROUTE_PERMIT", kindLabel: "Route permit" }),
    ]);
    expect(subject).toBe("FleetCo — 3 items need attention");
  });

  test("renders the Bikram-Sambat date and the precise-noun label in the text body", () => {
    const { text } = renderComplianceDigest([
      item({ subjectLabel: "BA 2 KHA 1234", kindLabel: "Bluebook" }),
    ]);
    // BS-prominent date with the Gregorian parenthetical (the shared formatter's
    // default `both` shape), never fabricated.
    expect(text).toContain("2083 Jestha 6 (2026-05-20)");
    expect(text).toContain("BA 2 KHA 1234 — Bluebook");
    expect(text).toContain("expired"); // the verb for the expired section
  });

  test("groups expired BEFORE expiring soon, regardless of input order", () => {
    const { text } = renderComplianceDigest([
      item({ subjectId: "v2", state: "expiring-soon", occurrenceKey: "2026-06-10T00:00:00.000Z" }),
      item({ subjectId: "v1", state: "expired", occurrenceKey: "2026-05-20T00:00:00.000Z" }),
    ]);
    expect(text.indexOf("Expired")).toBeLessThan(text.indexOf("Expiring soon"));
  });

  test("omits a section that has no items", () => {
    const { text } = renderComplianceDigest([item({ state: "expired" })]);
    expect(text).toContain("Expired");
    expect(text).not.toContain("Expiring soon");
  });

  test("uses the 'expires' verb for an expiring-soon item", () => {
    const { text } = renderComplianceDigest([
      item({ state: "expiring-soon", occurrenceKey: "2026-06-10T00:00:00.000Z" }),
    ]);
    expect(text).toContain("expires 2083"); // "expires <BS date>"
    expect(text).not.toContain("expired 2083");
  });

  test("§Voice: no exclamation marks anywhere", () => {
    const { subject, text, html } = renderComplianceDigest([
      item({ state: "expired" }),
      item({ subjectId: "v2", state: "expiring-soon", occurrenceKey: "2026-06-10T00:00:00.000Z" }),
    ]);
    expect(subject).not.toContain("!");
    expect(text).not.toContain("!");
    expect(html).not.toContain("!");
  });

  test("the plain-text body is mandatory and non-empty (ADR-0038 c7)", () => {
    const { text } = renderComplianceDigest([item()]);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/needs attention/);
  });

  test("HTML-escapes operator-entered values", () => {
    const { html } = renderComplianceDigest([item({ subjectLabel: "A & B <script>" })]);
    expect(html).toContain("A &amp; B &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
