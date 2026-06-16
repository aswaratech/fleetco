import { UserRole } from "@prisma/client";
import { describe, expect, test } from "vitest";

import { roleHasCapability } from "../src/modules/auth/permissions";

// D2 (ADR-0034 c5/c6): the DRIVER role is DEFINED with exactly the two write
// capabilities whose own-record scope D2 ships — trips:* and fuel-logs:*. The
// other two caps in the eventual lean set (gps:ingest, gps:read-derived) are
// DEFERRED to D4–D6 with their scopes (c5's hard rule: no write cap without its
// row predicate in the same change), so DRIVER must NOT hold them yet.
describe("DRIVER capability set (ADR-0034 c5/c6)", () => {
  test("DRIVER holds trips:* and fuel-logs:* (granted in D2)", () => {
    expect(roleHasCapability(UserRole.DRIVER, "trips:*")).toBe(true);
    expect(roleHasCapability(UserRole.DRIVER, "fuel-logs:*")).toBe(true);
  });

  test("DRIVER does NOT yet hold the deferred GPS caps, raw read, or other operational caps", () => {
    // Deferred to D4/D5 (gps:ingest) and D6 (gps:read-derived), each with its scope.
    expect(roleHasCapability(UserRole.DRIVER, "gps:ingest")).toBe(false);
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
