import { describe, expect, test } from "vitest";

import { type ReminderItem } from "../src/modules/notifications/compliance-source";
import { renderReminderDigest } from "../src/modules/notifications/digest";

// Pure unit tests for the reminder-digest renderer (ADR-0038 commitment 7). No
// DB, no network, no clock — like every FleetCo formatter test. Pins the §Voice
// register (no exclamation, precise nouns, state the fact), the Bikram-Sambat
// dates (via the shared formatNepaliDate), the expired-before-expiring-soon
// ordering, the mandatory plain-text body, and HTML escaping. C3 adds the
// MAINTENANCE domain: a service item renders under its own "Maintenance" block
// with its pre-rendered dueLabel (a meter value or BS date), overdue-before-due-
// soon, and the two domains batched together — Compliance first.

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

describe("renderReminderDigest (ADR-0038 C2 c7)", () => {
  test("subject states the count — singular for one item", () => {
    const { subject } = renderReminderDigest([item()]);
    expect(subject).toBe("FleetCo — 1 item needs attention");
  });

  test("subject pluralises for several items", () => {
    const { subject } = renderReminderDigest([
      item({ subjectId: "v1", reminderKind: "BLUEBOOK" }),
      item({ subjectId: "v2", reminderKind: "INSURANCE", kindLabel: "Insurance" }),
      item({ subjectId: "v3", reminderKind: "ROUTE_PERMIT", kindLabel: "Route permit" }),
    ]);
    expect(subject).toBe("FleetCo — 3 items need attention");
  });

  test("renders the Bikram-Sambat date and the precise-noun label in the text body", () => {
    const { text } = renderReminderDigest([
      item({ subjectLabel: "BA 2 KHA 1234", kindLabel: "Bluebook" }),
    ]);
    // BS-prominent date with the Gregorian parenthetical (the shared formatter's
    // default `both` shape), never fabricated.
    expect(text).toContain("2083 Jestha 6 (2026-05-20)");
    expect(text).toContain("BA 2 KHA 1234 — Bluebook");
    expect(text).toContain("expired"); // the verb for the expired section
  });

  test("groups expired BEFORE expiring soon, regardless of input order", () => {
    const { text } = renderReminderDigest([
      item({ subjectId: "v2", state: "expiring-soon", occurrenceKey: "2026-06-10T00:00:00.000Z" }),
      item({ subjectId: "v1", state: "expired", occurrenceKey: "2026-05-20T00:00:00.000Z" }),
    ]);
    expect(text.indexOf("Expired")).toBeLessThan(text.indexOf("Expiring soon"));
  });

  test("omits a section that has no items", () => {
    const { text } = renderReminderDigest([item({ state: "expired" })]);
    expect(text).toContain("Expired");
    expect(text).not.toContain("Expiring soon");
  });

  test("uses the 'expires' verb for an expiring-soon item", () => {
    const { text } = renderReminderDigest([
      item({ state: "expiring-soon", occurrenceKey: "2026-06-10T00:00:00.000Z" }),
    ]);
    expect(text).toContain("expires 2083"); // "expires <BS date>"
    expect(text).not.toContain("expired 2083");
  });

  test("§Voice: no exclamation marks anywhere", () => {
    const { subject, text, html } = renderReminderDigest([
      item({ state: "expired" }),
      item({ subjectId: "v2", state: "expiring-soon", occurrenceKey: "2026-06-10T00:00:00.000Z" }),
    ]);
    expect(subject).not.toContain("!");
    expect(text).not.toContain("!");
    expect(html).not.toContain("!");
  });

  test("the plain-text body is mandatory and non-empty (ADR-0038 c7)", () => {
    const { text } = renderReminderDigest([item()]);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/needs attention/);
  });

  test("HTML-escapes operator-entered values", () => {
    const { html } = renderReminderDigest([item({ subjectLabel: "A & B <script>" })]);
    expect(html).toContain("A &amp; B &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

// A maintenance reminder item (subjectType SERVICE_SCHEDULE). Its kindLabel is
// the schedule's own name, and its dueLabel is the source-pre-rendered meter /
// BS-date value (the digest renders it verbatim, never date-formatting a meter
// occurrenceKey).
function maintenanceItem(overrides: Partial<ReminderItem> = {}): ReminderItem {
  return {
    subjectType: "SERVICE_SCHEDULE",
    subjectId: "s1",
    subjectLabel: "BA 2 KHA 1234",
    reminderKind: "SERVICE",
    kindLabel: "250-hour oil & filter service",
    state: "overdue",
    occurrenceKey: "2500",
    dueLabel: "2,500 km",
    ...overrides,
  };
}

describe("renderReminderDigest — maintenance domain (ADR-0038 C3)", () => {
  test("renders a maintenance item under the Maintenance domain with its dueLabel", () => {
    const { text } = renderReminderDigest([maintenanceItem()]);
    expect(text).toContain("Maintenance");
    expect(text).toContain("Overdue");
    expect(text).toContain("250-hour oil & filter service");
    // The schedule's pre-rendered meter dueLabel, verb "overdue".
    expect(text).toContain("overdue 2,500 km");
  });

  test("renders the dueLabel verbatim — does NOT date-format a meter occurrenceKey", () => {
    const { text } = renderReminderDigest([
      maintenanceItem({ occurrenceKey: "2500", dueLabel: "2,500 km" }),
    ]);
    expect(text).toContain("2,500 km");
    // The meter occurrenceKey is never run through the BS formatter (no BS year).
    expect(text).not.toContain("2083");
  });

  test("uses the 'due' verb for a due-soon maintenance item", () => {
    const { text } = renderReminderDigest([
      maintenanceItem({ state: "due-soon", dueLabel: "250.0 h" }),
    ]);
    expect(text).toContain("Due soon");
    expect(text).toContain("due 250.0 h");
    expect(text).not.toContain("overdue");
  });

  test("groups Overdue BEFORE Due soon, regardless of input order", () => {
    const { text } = renderReminderDigest([
      maintenanceItem({ subjectId: "s2", state: "due-soon", dueLabel: "250.0 h" }),
      maintenanceItem({ subjectId: "s1", state: "overdue", dueLabel: "2,500 km" }),
    ]);
    expect(text.indexOf("Overdue")).toBeLessThan(text.indexOf("Due soon"));
  });

  test("renders a calendar maintenance item's BS-date dueLabel", () => {
    const { text } = renderReminderDigest([
      maintenanceItem({ dueLabel: "2083 Asar 27 (2026-06-10)" }),
    ]);
    expect(text).toContain("2083 Asar 27 (2026-06-10)");
  });

  test("§Voice: no exclamation marks in a maintenance digest", () => {
    const { subject, text, html } = renderReminderDigest([
      maintenanceItem({ state: "overdue" }),
      maintenanceItem({ subjectId: "s2", state: "due-soon", dueLabel: "250.0 h" }),
    ]);
    expect(subject).not.toContain("!");
    expect(text).not.toContain("!");
    expect(html).not.toContain("!");
  });

  test("HTML-escapes the operator-entered schedule name", () => {
    const { html } = renderReminderDigest([maintenanceItem({ kindLabel: "A & B <oil>" })]);
    expect(html).toContain("A &amp; B &lt;oil&gt;");
    expect(html).not.toContain("<oil>");
  });
});

describe("renderReminderDigest — both domains batched (ADR-0038 C3)", () => {
  test("renders Compliance and Maintenance blocks, compliance first", () => {
    const { subject, text } = renderReminderDigest([
      maintenanceItem({ state: "overdue", dueLabel: "2,500 km" }),
      item({ state: "expired" }),
    ]);
    expect(subject).toBe("FleetCo — 2 items need attention");
    expect(text).toContain("Compliance");
    expect(text).toContain("Maintenance");
    // Compliance domain renders before Maintenance domain regardless of input order.
    expect(text.indexOf("Compliance")).toBeLessThan(text.indexOf("Maintenance"));
  });

  test("a compliance-only digest renders no Maintenance block (domain omitted when empty)", () => {
    const { text } = renderReminderDigest([item({ state: "expired" })]);
    expect(text).toContain("Compliance");
    expect(text).not.toContain("Maintenance");
  });

  test("a maintenance-only digest renders no Compliance block", () => {
    const { text } = renderReminderDigest([maintenanceItem({ state: "overdue" })]);
    expect(text).toContain("Maintenance");
    expect(text).not.toContain("Compliance");
  });
});
