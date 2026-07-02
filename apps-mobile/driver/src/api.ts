import { authClient } from "./auth";
import type { FuelLogPayload } from "./fuel";
import { markSessionExpired } from "./session-expired";
import type { DriverTrip, TripStartPayload, TripStopPayload } from "./trips";

// The FleetCo API base URL — the same env the auth client reads (auth.ts), so a
// real phone points both at the operator's LAN IP / tunnel via EXPO_PUBLIC_API_URL.
const apiBaseUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Authenticated fetch against a FleetCo business endpoint. The @better-auth/expo
// client stores the session credential in expo-secure-store and exposes it via
// getCookie(); the server's AuthGuard resolves it through better-auth getSession
// (ADR-0034). The auth client attaches this to its own /auth/* calls; business
// endpoints (under /api/v1) attach it explicitly here.
async function apiFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const cookie = authClient.getCookie();
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (response.status === 401) {
    // Expired or revoked session (ADR-0034 c3a). Mark WHY before signing out
    // so the LoginForm can explain; then sign out so useSession() flips to
    // null and App.tsx routes to the login screen — without this, the cached
    // session kept rendering the trip screens and every request dead-ended in
    // a generic error with no way back (the 2026-07-02 audit finding).
    markSessionExpired();
    try {
      await authClient.signOut();
    } catch {
      // Best-effort: with the session already dead server-side, the sign-out
      // round-trip may itself fail; the local credential clear + session-state
      // flip is what matters for routing, and the thrown ApiError below still
      // surfaces the failure to the caller either way.
    }
    throw new ApiError(401, "Your session has expired. Please sign in again.");
  }
  if (!response.ok) {
    throw new ApiError(response.status, `Request failed (${response.status}).`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

interface TripsListResponse {
  items: DriverTrip[];
  total: number;
}

// The driver's own trips. The API auto-scopes a DRIVER session to their own rows
// (ADR-0034 D2), so no driverId filter is needed — newest first.
export async function listMyTrips(): Promise<DriverTrip[]> {
  const data = await apiFetch<TripsListResponse>(
    "/api/v1/trips?sortBy=createdAt&sortDir=desc&take=50",
  );
  return data.items;
}

// Start / stop a trip via the reused PATCH /trips/:id (ADR-0034 c7). The own-
// record predicate runs server-side; a foreign or unknown trip id 404s.
export async function patchTrip(
  id: string,
  body: TripStartPayload | TripStopPayload,
): Promise<DriverTrip> {
  return apiFetch<DriverTrip>(`/api/v1/trips/${id}`, { method: "PATCH", body });
}

// Log a fuel fill against one of the driver's own trips (ADR-0034 D2 own-record
// scope). The server derives totalCostPaisa + createdById and enforces that the
// trip is the driver's own (tripless → 400, foreign trip → 404). We only need the
// new row's id back. Reuses apiFetch, so the session cookie is attached as usual.
export async function createFuelLog(body: FuelLogPayload): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/v1/fuel-logs", { method: "POST", body });
}
