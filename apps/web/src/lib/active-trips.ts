// Active-trips layer helpers for the /map surface (ADR-0048; DESIGN.md
// §Surfaces "Live map" → "Active-trips layer"). Pure functions — no React,
// no Leaflet — all correctness lives here and in test/active-trips.test.ts;
// the map island stays thin (the map-markers.ts pattern).
//
// THE LAYER IS A READ-TIME JOIN (ADR-0048 c1): trips with a dispatched,
// non-terminal status joined to the latest-positions feed by
// `Trip.vehicleId`. `GpsPing.tripId` stays null — ADR-0042 c8's deferred
// ping-level correlation is NOT built here (ADR-0048 c3).
//
// TIER DISCIPLINE (ADR-0048 c4): the trips-list wire carries Tier-2
// consignee fields and order detail the map never renders. The projection
// below builds a FRESH object (never spreads the wire row), so the island's
// props/state provably never hold them — pinned by test.

/**
 * "Active" ON THE MAP = every dispatched, non-terminal trip (ADR-0048 c1's
 * PO-decided set). Deliberately wider than the Home dashboard's
 * IN_PROGRESS-only "active" — both usages are recorded in the glossary's
 * "Active trip" entry so they cannot drift silently.
 */
export const ACTIVE_TRIP_STATUSES = ["OFFERED", "ACCEPTED", "IN_PROGRESS"] as const;

export type ActiveTripStatus = (typeof ACTIVE_TRIP_STATUSES)[number];

/**
 * The exact trips-list query — ONE source for the server page's initial
 * fetch and the island's poll, so the two cannot drift. take=200 mirrors the
 * list endpoint's pagination ceiling (the Home-dashboard caveat; the silent
 * truncation past 200 concurrent active trips is named tech-debt).
 */
export const ACTIVE_TRIPS_QUERY = `status=${ACTIVE_TRIP_STATUSES.join(",")}&take=200&sortBy=createdAt&sortDir=desc`;

/**
 * The trips layer polls at its own slower cadence beside the 20 s positions
 * poll (ADR-0048 c5) — the honest ≤60 s layer lag is stated in DESIGN.md's
 * Refresh bullet.
 */
export const TRIPS_POLL_INTERVAL_MS = 60_000;

/** A pickup/drop-off Site pin — Tier-3 (a fixed business location). */
export interface ActiveTripSite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * The slim shape the map island receives. Built fresh by
 * `toActiveTripOverlay` — deliberately NO consigneeName / consigneePhone /
 * specialInstructions / docketNumber / materialNote (Tier-2 PII and order
 * detail the map does not render; ADR-0048 c4).
 */
export interface ActiveTripOverlay {
  id: string;
  status: ActiveTripStatus;
  vehicleId: string;
  registrationNumber: string;
  driverName: string;
  pickupSite: ActiveTripSite | null;
  dropoffSite: ActiveTripSite | null;
  startedAt: string | null;
  acceptedAt: string | null;
  offeredAt: string | null;
  createdAt: string;
}

/**
 * The subset of the API trips-list wire row this layer reads
 * (apps/api/src/modules/trips/trips.service.ts LIST_SELECT). The Tier-2 /
 * order-detail keys are declared optional so the projection's drop of them
 * is type-visible and testable — they must never be copied to the overlay.
 */
export interface ActiveTripWireRow {
  id: string;
  status: string;
  vehicleId: string;
  startedAt: string | null;
  acceptedAt: string | null;
  offeredAt: string | null;
  createdAt: string;
  vehicle: { id: string; registrationNumber: string };
  driver: { id: string; fullName: string };
  pickupSite: ActiveTripSite | null;
  dropoffSite: ActiveTripSite | null;
  /** On the wire, never copied (Tier 2 — ADR-0048 c4). */
  consigneeName?: string | null;
  /** On the wire, never copied (Tier 2 — ADR-0048 c4). */
  consigneePhone?: string | null;
  /** On the wire, never copied (order detail the map does not render). */
  specialInstructions?: string | null;
  /** On the wire, never copied (order detail the map does not render). */
  docketNumber?: string | null;
  /** On the wire, never copied (order detail the map does not render). */
  materialNote?: string | null;
}

export interface ActiveTripsWireResponse {
  items: ActiveTripWireRow[];
  total: number;
}

export function isActiveTripStatus(status: string): status is ActiveTripStatus {
  return (ACTIVE_TRIP_STATUSES as readonly string[]).includes(status);
}

/**
 * Project a wire row to the island's slim shape. Builds a fresh object —
 * never spreads the row — so the Tier-2 keys structurally cannot leak into
 * the overlay. Returns null for a non-active status (defensive: the query
 * already filters, but the mapper must not trust the wire).
 */
export function toActiveTripOverlay(row: ActiveTripWireRow): ActiveTripOverlay | null {
  if (!isActiveTripStatus(row.status)) return null;
  const site = (s: ActiveTripSite | null): ActiveTripSite | null =>
    s === null ? null : { id: s.id, name: s.name, latitude: s.latitude, longitude: s.longitude };
  return {
    id: row.id,
    status: row.status,
    vehicleId: row.vehicleId,
    registrationNumber: row.vehicle.registrationNumber,
    driverName: row.driver.fullName,
    pickupSite: site(row.pickupSite),
    dropoffSite: site(row.dropoffSite),
    startedAt: row.startedAt,
    acceptedAt: row.acceptedAt,
    offeredAt: row.offeredAt,
    createdAt: row.createdAt,
  };
}

/** Map a wire page to overlays, dropping non-active rows. */
export function mapActiveTrips(rows: ActiveTripWireRow[]): ActiveTripOverlay[] {
  return rows.map(toActiveTripOverlay).filter((t): t is ActiveTripOverlay => t !== null);
}

// Rank for the per-vehicle pick: the most operationally "live" status wins.
const STATUS_RANK: Record<ActiveTripStatus, number> = {
  IN_PROGRESS: 3,
  ACCEPTED: 2,
  OFFERED: 1,
};

/**
 * The trip's most recent lifecycle instant, for the recency tie-break. ISO
 * 8601 UTC strings (the API wire format) compare correctly as strings.
 */
function recencyKey(t: ActiveTripOverlay): string {
  return t.startedAt ?? t.acceptedAt ?? t.offeredAt ?? t.createdAt;
}

/**
 * The marker/popup's one-trip-per-vehicle pick (ADR-0048 c1). No DB
 * uniqueness guarantees one active trip per vehicle (named tech-debt), so
 * the pick is deterministic: status rank IN_PROGRESS > ACCEPTED > OFFERED,
 * then newest recencyKey, then `id` — the sidebar lists ALL active trips
 * regardless, so nothing is hidden by the pick.
 */
export function activeTripByVehicle(trips: ActiveTripOverlay[]): Map<string, ActiveTripOverlay> {
  const byVehicle = new Map<string, ActiveTripOverlay>();
  for (const trip of trips) {
    const current = byVehicle.get(trip.vehicleId);
    if (current === undefined || beats(trip, current)) {
      byVehicle.set(trip.vehicleId, trip);
    }
  }
  return byVehicle;
}

function beats(a: ActiveTripOverlay, b: ActiveTripOverlay): boolean {
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank > 0;
  const recency = recencyKey(a).localeCompare(recencyKey(b));
  if (recency !== 0) return recency > 0;
  return a.id.localeCompare(b.id) > 0;
}

/** One rendered map pin: a trip endpoint, deduped by (siteId, role). */
export interface TripPin {
  /** Stable render key: `${role}:${siteId}`. */
  key: string;
  role: "pickup" | "dropoff";
  siteId: string;
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * The always-on pickup/drop-off pins (ADR-0048 c4, the PO's always-on
 * pick): one pin per (site, role) across all active trips — two trips
 * loading at the same crusher share one pin — with null sites skipped.
 */
export function tripPins(trips: ActiveTripOverlay[]): TripPin[] {
  const pins = new Map<string, TripPin>();
  for (const trip of trips) {
    for (const role of ["pickup", "dropoff"] as const) {
      const site = role === "pickup" ? trip.pickupSite : trip.dropoffSite;
      if (site === null) continue;
      const key = `${role}:${site.id}`;
      if (!pins.has(key)) {
        pins.set(key, {
          key,
          role,
          siteId: site.id,
          name: site.name,
          latitude: site.latitude,
          longitude: site.longitude,
        });
      }
    }
  }
  return [...pins.values()];
}
