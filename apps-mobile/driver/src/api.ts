import { authClient } from "./auth";
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
