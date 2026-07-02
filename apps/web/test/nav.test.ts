import { describe, expect, test } from "vitest";

import { HOME, NAV, navForRole, navItemsForRole } from "../src/lib/nav";

/**
 * Pins the shared navigation source (apps/web/src/lib/nav.ts) — the single list
 * the §Navigation sidebar (T3), the home quick-links strip, and the ⌘K palette
 * (T7) will all read from. The load-bearing assertions are (a) the flattened
 * groups equal EXACTLY the canonical destination set below (the 15 quick-links
 * destinations + Trackers from ADR-0042 M4), so no screen strands and none
 * sneaks in unpinned, and
 * (b) the role filter is fail-closed for DRIVER (web is admin-facing; DRIVER
 * uses the Expo app). RBAC here is a UI affordance only — the API's
 * permissions.ts is the security boundary.
 */

// The canonical destination set. The first 15 are the destinations in
// apps/web/src/app/_dashboard/quick-links.tsx as of the Phase-0 strip;
// Trackers joined with ADR-0042 M4 (telematics configuration, Logs group).
// Order-independent on purpose: the five groups deliberately regroup these.
// The SET, however, must not drift — a new destination is added HERE and in
// nav.ts in the same commit, deliberate friction against silent IA growth.
const QUICK_LINKS_TODAY: readonly { href: string; label: string }[] = [
  { href: "/vehicles", label: "Vehicles" },
  { href: "/drivers", label: "Drivers" },
  { href: "/trips", label: "Trips" },
  { href: "/customers", label: "Customers" },
  { href: "/jobs", label: "Jobs" },
  { href: "/invoices", label: "Invoices" },
  { href: "/fuel-logs", label: "Fuel logs" },
  { href: "/expense-logs", label: "Expense logs" },
  { href: "/geofences", label: "Geofences" },
  { href: "/trackers", label: "Trackers" },
  { href: "/service-schedules", label: "Service schedules" },
  { href: "/service-records", label: "Service history" },
  { href: "/service-schedules/due", label: "Services due" },
  { href: "/reports/per-vehicle-cost", label: "Cost report" },
  { href: "/reports/per-vehicle-efficiency", label: "Fuel efficiency" },
  { href: "/notification-logs", label: "Reminder history" },
];

const key = (i: { href: string; label: string }): string => `${i.href}\t${i.label}`;

describe("NAV structure", () => {
  test("has the five ratified groups, in order", () => {
    expect(NAV.map((g) => g.id)).toEqual(["operations", "money", "maintenance", "reports", "logs"]);
    expect(NAV.map((g) => g.label)).toEqual([
      "Operations",
      "Money",
      "Maintenance",
      "Reports",
      "Logs",
    ]);
  });

  test("flattens to exactly the canonical destination set (no strand, no add)", () => {
    const flat = NAV.flatMap((g) => g.items)
      .map(key)
      .sort();
    expect(flat).toEqual([...QUICK_LINKS_TODAY].map(key).sort());
  });

  test("every href is unique (HOME included)", () => {
    const hrefs = [HOME, ...NAV.flatMap((g) => g.items)].map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("every item carries an icon and at least one allowed role", () => {
    for (const item of [HOME, ...NAV.flatMap((g) => g.items)]) {
      expect(item.icon).toBeTruthy();
      expect(item.allowedRoles.length).toBeGreaterThan(0);
    }
  });
});

describe("navForRole", () => {
  test("ADMIN and OFFICE_STAFF see all five groups and all sixteen items", () => {
    for (const role of ["ADMIN", "OFFICE_STAFF"] as const) {
      const groups = navForRole(role);
      expect(groups.map((g) => g.id)).toEqual([
        "operations",
        "money",
        "maintenance",
        "reports",
        "logs",
      ]);
      expect(groups.flatMap((g) => g.items)).toHaveLength(16);
    }
  });

  test("DRIVER sees nothing on the web; empty groups are dropped", () => {
    expect(navForRole("DRIVER")).toEqual([]);
  });

  test("does not mutate NAV", () => {
    const before = JSON.stringify(NAV.map((g) => ({ id: g.id, n: g.items.length })));
    navForRole("ADMIN");
    navForRole("DRIVER");
    const after = JSON.stringify(NAV.map((g) => ({ id: g.id, n: g.items.length })));
    expect(after).toBe(before);
  });
});

describe("navItemsForRole", () => {
  test("prepends HOME for the web roles (17 = HOME + 16)", () => {
    const items = navItemsForRole("ADMIN");
    expect(items[0]).toBe(HOME);
    expect(items).toHaveLength(17);
  });

  test("is empty for DRIVER (HOME is ADMIN/OFFICE only)", () => {
    expect(navItemsForRole("DRIVER")).toEqual([]);
  });
});
