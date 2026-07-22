import { describe, expect, test } from "vitest";

import {
  reminderKindLabel,
  stateBadgeVariant,
  stateLabel,
  subjectTypeLabel,
  SUBJECT_TYPE_FILTER_OPTIONS,
} from "../src/lib/notification-logs";

// Pins the pure display maps for the NotificationLog audit view (ADR-0038 C4):
// the operator labels for the open-string subjectType / reminderKind / state
// tokens, the state → Badge variant mapping, and — the load-bearing forward-
// compat property — that every map FALLS BACK to the raw token for a value it
// does not yet know (so a future reminder source's new subject/kind/state still
// renders its token rather than a blank cell). The API stores these as open
// strings precisely so a new source needs no migration; the web must degrade as
// gracefully.

describe("subjectTypeLabel", () => {
  test("maps the three known domains to operator labels", () => {
    expect(subjectTypeLabel("VEHICLE")).toBe("Vehicle compliance");
    expect(subjectTypeLabel("SERVICE_SCHEDULE")).toBe("Service schedule");
    // ADR-0049 F6: the fleet-document reminder domain.
    expect(subjectTypeLabel("DOCUMENT")).toBe("Document");
  });

  test("falls back to the raw token for an unknown subjectType", () => {
    expect(subjectTypeLabel("FUTURE_DOMAIN")).toBe("FUTURE_DOMAIN");
  });
});

describe("reminderKindLabel", () => {
  test("maps the known kinds to precise-noun labels", () => {
    expect(reminderKindLabel("BLUEBOOK")).toBe("Bluebook");
    expect(reminderKindLabel("INSURANCE")).toBe("Insurance");
    expect(reminderKindLabel("ROUTE_PERMIT")).toBe("Route permit");
    expect(reminderKindLabel("SERVICE")).toBe("Service");
    // ADR-0049 F6: the document-category kinds.
    expect(reminderKindLabel("AGREEMENT")).toBe("Agreement");
    expect(reminderKindLabel("LICENSE")).toBe("License");
    expect(reminderKindLabel("ID_DOCUMENT")).toBe("ID document");
  });

  test("falls back to the raw token for an unknown kind", () => {
    expect(reminderKindLabel("EMISSIONS_TEST")).toBe("EMISSIONS_TEST");
  });
});

describe("stateLabel", () => {
  test("maps the four remind-worthy states to labels", () => {
    expect(stateLabel("expired")).toBe("Expired");
    expect(stateLabel("expiring-soon")).toBe("Expiring soon");
    expect(stateLabel("overdue")).toBe("Overdue");
    expect(stateLabel("due-soon")).toBe("Due soon");
  });

  test("falls back to the raw token for an unknown state", () => {
    expect(stateLabel("lapsed")).toBe("lapsed");
  });
});

describe("stateBadgeVariant", () => {
  test("past-the-line states are red error", () => {
    expect(stateBadgeVariant("expired")).toBe("error");
    expect(stateBadgeVariant("overdue")).toBe("error");
  });

  test("approaching-the-line states are amber warning", () => {
    expect(stateBadgeVariant("expiring-soon")).toBe("warning");
    expect(stateBadgeVariant("due-soon")).toBe("warning");
  });

  test("an unknown state degrades to neutral (never throws, never blank)", () => {
    expect(stateBadgeVariant("something-new")).toBe("neutral");
  });
});

describe("SUBJECT_TYPE_FILTER_OPTIONS", () => {
  test("offers the three known domains — compliance, documents, maintenance", () => {
    expect(SUBJECT_TYPE_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      "VEHICLE",
      "DOCUMENT",
      "SERVICE_SCHEDULE",
    ]);
  });
});
