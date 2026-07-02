// Session-expiry flag (ADR-0034 c3a — the mid-trip re-auth UX).
//
// When apiFetch hits a 401 (expired/revoked session), it marks this flag and
// signs out; the sign-out flips authClient.useSession() to null, which routes
// App.tsx back to the LoginForm. The LoginForm CONSUMES the flag (read-and-
// clear) on mount to tell the driver WHY they are looking at the login screen
// — "session expired, sign in again" — instead of the unexplained dead end the
// 2026-07-02 audit found (a permanent generic "Could not load your trips."
// with no way back).
//
// A module-level flag, not React state, on purpose: the writer (the api layer)
// is not a component, the reader (LoginForm) mounts AFTER the writer runs, and
// the app is a single conditional tree with no navigation/params to carry it.
// Pure and directly unit-testable (see session-expired.test.ts).

let expired = false;

/** Called by the api layer when the server answers 401. */
export function markSessionExpired(): void {
  expired = true;
}

/**
 * Read-and-clear: returns whether a session expiry caused the current visit to
 * the login screen, and resets the flag so a later ordinary sign-out does not
 * replay the notice.
 */
export function consumeSessionExpired(): boolean {
  const was = expired;
  expired = false;
  return was;
}
