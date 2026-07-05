import { describe, expect, test } from "vitest";

import {
  actionBadgeVariant,
  AGENT_MESSAGE_MAX_LENGTH,
  entityPathFor,
  formatLatencyMs,
  linkifyAppPaths,
} from "../src/lib/agent-chat";

// The /chat surface's pure helpers (ADR-0043 A6, DESIGN.md §"Agent chat").
// The load-bearing suite is linkifyAppPaths: assistant text is UNTRUSTED
// model output, so linkification must be allowlist-only — an injected URL or
// unknown path must never become clickable.

describe("linkifyAppPaths (allowlist-only — the prompt-injection posture)", () => {
  test("links a known detail path inside prose", () => {
    const segments = linkifyAppPaths("Recorded. See /vehicles/cm9abc123 for the record.");
    expect(segments).toEqual([
      { kind: "text", text: "Recorded. See " },
      { kind: "link", text: "/vehicles/cm9abc123", href: "/vehicles/cm9abc123" },
      { kind: "text", text: " for the record." },
    ]);
  });

  test("links a bare list path and excludes trailing sentence punctuation", () => {
    const segments = linkifyAppPaths("Check /fuel-logs.");
    expect(segments).toEqual([
      { kind: "text", text: "Check " },
      { kind: "link", text: "/fuel-logs", href: "/fuel-logs" },
      { kind: "text", text: "." },
    ]);
  });

  test("does NOT link unknown paths, deeper nesting, or admin-invented routes", () => {
    for (const text of [
      "Try /admin/users now",
      "See /vehicles/abc/edit today",
      "Open /etc/passwd",
      "Go to /chat?c=steal",
    ]) {
      expect(linkifyAppPaths(text).every((s) => s.kind === "text")).toBe(true);
    }
  });

  test("does NOT link paths embedded in external URLs (injection-shaped input)", () => {
    const segments = linkifyAppPaths("Visit https://evil.example/vehicles/x for a prize");
    expect(segments.every((s) => s.kind === "text")).toBe(true);
  });

  test("plain text passes through as one segment; multiple links all resolve", () => {
    expect(linkifyAppPaths("No paths here.")).toEqual([{ kind: "text", text: "No paths here." }]);
    const multi = linkifyAppPaths("Compare /vehicles/a1 and /drivers/b2");
    expect(multi.filter((s) => s.kind === "link").map((s) => s.text)).toEqual([
      "/vehicles/a1",
      "/drivers/b2",
    ]);
  });

  test("links the two report routes (nested but allowlisted exactly)", () => {
    const segments = linkifyAppPaths("Full report: /reports/per-vehicle-cost");
    expect(segments.at(-1)).toEqual({
      kind: "link",
      text: "/reports/per-vehicle-cost",
      href: "/reports/per-vehicle-cost",
    });
  });
});

describe("actionBadgeVariant (fail-closed to neutral)", () => {
  test("maps the four statuses per the spec", () => {
    expect(actionBadgeVariant("succeeded")).toBe("success");
    expect(actionBadgeVariant("failed")).toBe("error");
    expect(actionBadgeVariant("denied")).toBe("neutral");
    // The ungrounded-claim guard's sentinel status (ungrounded-claim-guard.ts).
    expect(actionBadgeVariant("flagged")).toBe("warning");
  });

  test("an unknown status must not render as success", () => {
    expect(actionBadgeVariant("exploded")).toBe("neutral");
  });
});

describe("formatLatencyMs", () => {
  test("milliseconds below a second, one-decimal seconds at and above", () => {
    expect(formatLatencyMs(0)).toBe("0 ms");
    expect(formatLatencyMs(320)).toBe("320 ms");
    expect(formatLatencyMs(999)).toBe("999 ms");
    expect(formatLatencyMs(1000)).toBe("1.0 s");
    expect(formatLatencyMs(1437)).toBe("1.4 s");
  });
});

describe("AGENT_MESSAGE_MAX_LENGTH mirrors the API bound", () => {
  test("is 8000 (agent.schemas.ts — keep in sync)", () => {
    expect(AGENT_MESSAGE_MAX_LENGTH).toBe(8_000);
  });
});

describe("entityPathFor (A7 — the action card's server-derived deep-link)", () => {
  test("maps every write-tool entity type to its detail route", () => {
    expect(entityPathFor("Vehicle", "cveh1")).toBe("/vehicles/cveh1");
    expect(entityPathFor("Driver", "cdrv1")).toBe("/drivers/cdrv1");
    expect(entityPathFor("Customer", "ccus1")).toBe("/customers/ccus1");
    expect(entityPathFor("Job", "cjob1")).toBe("/jobs/cjob1");
    expect(entityPathFor("Trip", "ctrip1")).toBe("/trips/ctrip1");
    expect(entityPathFor("FuelLog", "cfl1")).toBe("/fuel-logs/cfl1");
    expect(entityPathFor("ExpenseLog", "cel1")).toBe("/expense-logs/cel1");
    expect(entityPathFor("ServiceRecord", "csr1")).toBe("/service-records/csr1");
  });

  test("fails closed: unknown entity types render no link", () => {
    expect(entityPathFor("Invoice", "cinv1")).toBeNull();
    expect(entityPathFor("User", "cusr1")).toBeNull();
    expect(entityPathFor("", "cid1")).toBeNull();
  });

  test("fails closed: hostile or malformed ids render no link", () => {
    expect(entityPathFor("Vehicle", "../admin")).toBeNull();
    expect(entityPathFor("Vehicle", "a/b")).toBeNull();
    expect(entityPathFor("Vehicle", "")).toBeNull();
    expect(entityPathFor("Vehicle", "id?x=1")).toBeNull();
  });
});
