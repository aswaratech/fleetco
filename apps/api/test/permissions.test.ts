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
