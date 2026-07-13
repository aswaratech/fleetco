import { UserRole } from "@prisma/client";
import { describe, expect, test } from "vitest";

import { roleHasCapability } from "../src/modules/auth/permissions";

// ADR-0034 c5/c6: the DRIVER role's lean capability set is reached
// INCREMENTALLY, each write cap landing atomically with its row-level scope
// (c5's hard rule). D2 shipped trips:* + fuel-logs:* with the own-record
// predicate; D4 (ADR-0035, resumed 2026-07-10) shipped gps:ingest with the
// own-IN_PROGRESS-trip predicate (TelematicsService.assertDriverCanIngest).
// gps:read-derived stays deferred to D6 (own-vehicle scope, geofence context).
describe("DRIVER capability set (ADR-0034 c5/c6)", () => {
  test("DRIVER holds trips:* and fuel-logs:* (granted in D2)", () => {
    expect(roleHasCapability(UserRole.DRIVER, "trips:*")).toBe(true);
    expect(roleHasCapability(UserRole.DRIVER, "fuel-logs:*")).toBe(true);
  });

  test("DRIVER holds gps:ingest (D4, with its scope); the D6 cap, raw read, and operational caps stay off", () => {
    // Granted in D4 with assertDriverCanIngest (ADR-0034 c5 honored);
    // gps:read-derived stays deferred to D6 with its own-vehicle scope.
    expect(roleHasCapability(UserRole.DRIVER, "gps:ingest")).toBe(true);
    expect(roleHasCapability(UserRole.DRIVER, "gps:read-derived")).toBe(false);
    // Always ADMIN-only — the raw trace is the most-privileged class (ADR-0027 c7).
    expect(roleHasCapability(UserRole.DRIVER, "gps:read-raw")).toBe(false);
    // Not granted: other operational aggregates + admin/config surfaces.
    expect(roleHasCapability(UserRole.DRIVER, "vehicles:*")).toBe(false);
    expect(roleHasCapability(UserRole.DRIVER, "reports:read")).toBe(false);
    expect(roleHasCapability(UserRole.DRIVER, "geofences:read")).toBe(false);
    expect(roleHasCapability(UserRole.DRIVER, "users:manage")).toBe(false);
  });

  test("ADMIN and OFFICE_STAFF still hold trips:* / fuel-logs:* (unchanged by D2)", () => {
    for (const role of [UserRole.ADMIN, UserRole.OFFICE_STAFF]) {
      expect(roleHasCapability(role, "trips:*")).toBe(true);
      expect(roleHasCapability(role, "fuel-logs:*")).toBe(true);
    }
  });
});

// ADR-0047 c4/c10: the Sites aggregate (reusable pickup/drop-off pins) is gated
// by a COARSE `sites:*` capability on the shared operational floor — dispatch
// data entry both live roles do. It is deliberately NOT granted to DRIVER
// (orders come only from the admin app; a driver never manages sites) and NOT a
// read/write split (a Site is operational master data, not users:manage-tier
// configuration the way a geofence boundary is).
describe("sites:* capability (ADR-0047 c4/c10)", () => {
  test("ADMIN and OFFICE_STAFF hold sites:* (the shared operational floor)", () => {
    expect(roleHasCapability(UserRole.ADMIN, "sites:*")).toBe(true);
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "sites:*")).toBe(true);
  });

  test("DRIVER does NOT hold sites:* (orders come only from the admin app)", () => {
    expect(roleHasCapability(UserRole.DRIVER, "sites:*")).toBe(false);
  });
});
