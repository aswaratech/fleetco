import { describe, expect, test } from "@jest/globals";

import { consumeSessionExpired, markSessionExpired } from "./session-expired";

// The 401 → login-notice seam (ADR-0034 c3a). The flag is the only piece of the
// re-auth path that is pure (the rest is authClient sign-out + React routing),
// so it carries the unit coverage: mark → consume reads true exactly once.
describe("session-expired flag", () => {
  test("starts unset: an ordinary visit to the login screen shows no notice", () => {
    expect(consumeSessionExpired()).toBe(false);
  });

  test("mark → consume returns true once, then clears (no replay on a later sign-out)", () => {
    markSessionExpired();
    expect(consumeSessionExpired()).toBe(true);
    // A second consume — e.g. the driver signs in and later signs out
    // manually, mounting LoginForm again — must NOT replay the notice.
    expect(consumeSessionExpired()).toBe(false);
  });

  test("double-mark still consumes as a single notice", () => {
    // Two parallel in-flight requests can both hit 401 (trips load + a fuel
    // submit racing an expiry); the login screen still shows one notice.
    markSessionExpired();
    markSessionExpired();
    expect(consumeSessionExpired()).toBe(true);
    expect(consumeSessionExpired()).toBe(false);
  });
});
