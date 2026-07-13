import { authClient } from "./auth";
import type { FuelLogPayload } from "./fuel";
import type { MapPoint, RoutePreviewResult } from "./routing";
import { markSessionExpired } from "./session-expired";
import type {
  DriverTrip,
  MilestonePayload,
  TripAcceptPayload,
  TripStartPayload,
  TripStatus,
  TripStopPayload,
} from "./trips";

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

// Pull a human-readable message out of a NestJS error body so the caller can
// surface the API's OWN reason (ADR-0047 W7: a reassigned/withdrawn trip 400s /
// 403s / 404s on Accept, and the driver should see why — "Illegal status
// transition: …", "Trip … not found.", etc. — not a bare status code). Nest
// shapes errors as { statusCode, message, error } where `message` is a string
// (HttpException) or a string[] (class-validator). Returns null when the body is
// absent or not JSON, so the caller falls back to a generic message.
async function readApiErrorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
    if (Array.isArray(message) && message.length > 0) {
      return message.map((m) => String(m)).join(" ");
    }
    return null;
  } catch {
    // Non-JSON body (an HTML 502 from a proxy, an empty body, …) — fall back.
    return null;
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
    const serverMessage = await readApiErrorMessage(response);
    throw new ApiError(response.status, serverMessage ?? `Request failed (${response.status}).`);
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
// (ADR-0034 D2), so no driverId filter is needed — newest first. An optional
// status narrows the set: the Requests tab passes "OFFERED" (ADR-0047 W7), the
// Trips/Fuel screens pass nothing (all statuses). The status is a bare enum
// value (no special chars), so it interpolates safely into the query string.
export async function listMyTrips(opts: { status?: TripStatus } = {}): Promise<DriverTrip[]> {
  const statusQuery = opts.status ? `&status=${opts.status}` : "";
  const data = await apiFetch<TripsListResponse>(
    `/api/v1/trips?sortBy=createdAt&sortDir=desc&take=50${statusQuery}`,
  );
  return data.items;
}

// Accept an offered trip: PATCH OFFERED → ACCEPTED (ADR-0047 c8). The server
// stamps acceptedAt and runs the own-record predicate — a foreign/unknown trip
// 404s, and a trip no longer OFFERED (reassigned/withdrawn) 400s with a message
// apiFetch now surfaces. A driver still cannot create or delete trips. The
// response is the accepted trip's detail shape.
export async function acceptTrip(id: string): Promise<DriverTrip> {
  const body: TripAcceptPayload = { status: "ACCEPTED" };
  return apiFetch<DriverTrip>(`/api/v1/trips/${id}`, { method: "PATCH", body });
}

// Start / stop a trip via the reused PATCH /trips/:id (ADR-0034 c7). The own-
// record predicate runs server-side; a foreign or unknown trip id 404s.
export async function patchTrip(
  id: string,
  body: TripStartPayload | TripStopPayload,
): Promise<DriverTrip> {
  return apiFetch<DriverTrip>(`/api/v1/trips/${id}`, { method: "PATCH", body });
}

// Stamp one live-progress milestone on the driver's own IN_PROGRESS trip
// (ADR-0047 c8, W8) via the SAME own-record PATCH path (DriverScopeService). The
// body carries exactly one milestone timestamp and NO status change. The server
// enforces the monotonic-milestone rule, so an out-of-order tap 400s with a
// message apiFetch surfaces (e.g. "loadedAt must be greater than or equal to
// arrivedPickupAt."); the response is the trip's refreshed detail shape.
export async function patchTripMilestone(id: string, body: MilestonePayload): Promise<DriverTrip> {
  return apiFetch<DriverTrip>(`/api/v1/trips/${id}`, { method: "PATCH", body });
}

// Preview the pickup → drop-off route for the order-detail map (ADR-0047 c9, W8).
// POSTs the two coordinates to the W6 route-preview endpoint, which is gated on
// `trips:*` — a capability the DRIVER holds — so the driver's own cookie session
// reaches it. Returns the polyline ([lat, lng] pairs) + estimated distance /
// duration. The endpoint reads coordinates from the POST BODY, never a URL query
// string (Tier-5 location discipline). The caller degrades gracefully on any
// failure (the pins still render, no route line) — see OrderDetail.
export async function routePreview(
  origin: MapPoint,
  destination: MapPoint,
): Promise<RoutePreviewResult> {
  return apiFetch<RoutePreviewResult>("/api/v1/routing/route-preview", {
    method: "POST",
    body: {
      origin: { lat: origin.latitude, lng: origin.longitude },
      destination: { lat: destination.latitude, lng: destination.longitude },
    },
  });
}

// Log a fuel fill against one of the driver's own trips (ADR-0034 D2 own-record
// scope). The server derives totalCostPaisa + createdById and enforces that the
// trip is the driver's own (tripless → 400, foreign trip → 404). We only need the
// new row's id back. Reuses apiFetch, so the session cookie is attached as usual.
export async function createFuelLog(body: FuelLogPayload): Promise<{ id: string }> {
  return apiFetch<{ id: string }>("/api/v1/fuel-logs", { method: "POST", body });
}

// POST a batch of GPS fixes for the driver's active trip (ADR-0035 D4). The
// server's own-trip predicate enforces that every ping carries the driver's own
// IN_PROGRESS trip (a foreign/ended trip or a missing tripId 403s the whole
// batch); the route answers 202 and the worker inserts asynchronously. The wire
// shape is src/gps.ts's hand-mirrored WirePing (ADR-0033 c3).
export async function postGpsPings(
  pings: readonly import("./gps").WirePing[],
): Promise<{ accepted: number; jobId: string | null }> {
  return apiFetch<{ accepted: number; jobId: string | null }>("/api/v1/telematics/pings", {
    method: "POST",
    body: { pings },
  });
}
