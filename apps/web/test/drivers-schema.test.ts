import { describe, expect, test } from "vitest";

import { LinkDriverLoginFormSchema } from "../src/lib/drivers-schema";

// Pure-function tests for the driver-detail login-link panel's form schema
// (2026-07-05, ADR-0034 c8's write path). Scoped to LinkDriverLoginFormSchema
// only — the pre-existing DriverFormSchema/CreateDriverFormSchema/
// UpdateDriverFormSchema have no dedicated test file today (backfilling them
// is out of scope for this change); the API's authoritative mirror is
// pinned by apps/api/test/drivers.controller.test.ts's login-link schema
// block.

describe("LinkDriverLoginFormSchema", () => {
  test("accepts a well-formed email", () => {
    const result = LinkDriverLoginFormSchema.safeParse({ email: "driver@fleetco.test" });
    expect(result.success).toBe(true);
  });

  test("trims surrounding whitespace", () => {
    const result = LinkDriverLoginFormSchema.safeParse({ email: "  driver@fleetco.test  " });
    expect(result.success).toBe(true);
    expect(result.success && result.data.email).toBe("driver@fleetco.test");
  });

  test("rejects an empty email", () => {
    const result = LinkDriverLoginFormSchema.safeParse({ email: "" });
    expect(result.success).toBe(false);
  });

  test("rejects a missing email field", () => {
    const result = LinkDriverLoginFormSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects a malformed email (no @)", () => {
    const result = LinkDriverLoginFormSchema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  test("rejects an email longer than 256 characters", () => {
    // 251 + "@b.com" (6) = 257 chars, one past the max(256) boundary.
    const longEmail = `${"a".repeat(251)}@b.com`;
    const result = LinkDriverLoginFormSchema.safeParse({ email: longEmail });
    expect(result.success).toBe(false);
  });
});
