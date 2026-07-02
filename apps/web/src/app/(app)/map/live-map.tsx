"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polygon,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";

import "leaflet/dist/leaflet.css";

import { vertexInputToLatLngs, type LatLngLike } from "@/lib/geofence-latlng";
import { wktToVertexInput } from "@/lib/geofences-schema";
import { fixAgeInWords, markerStateForAge, type MarkerState } from "@/lib/map-markers";
import { formatNepaliDate } from "@/lib/nepali-date";
import { VEHICLE_KIND_LABELS } from "@/lib/vehicles-schema";

import type { DepotFence, LatestPosition, LatestPositionsResponse } from "./types";

// The /map client island (ADR-0042 M9; DESIGN.md §Surfaces "Live map").
// Client-only — Leaflet touches `window` at module load — imported via
// next/dynamic ssr:false from live-map-loader.tsx (the geofence-editor
// precedent, minus Geoman: this map is read-only). The island stays thin:
// classification lives in the pure lib/map-markers helpers, WKT decoding in
// the shipped geofence serializers.
//
// POLLING (the first client-side poll in the app): every 20 s against the
// M7 latest-positions endpoint, straight from the browser with the
// first-party session cookie (`credentials: "include"` — apiFetch is
// server-only and cannot run here). Paused while the tab is hidden (an
// always-open ops tab must not hammer the API or the OSM tiles), and
// resumed-AND-fired on visibility return so the operator never stares at a
// paused snapshot. A failed poll keeps the last markers and states the
// network line in the sidebar — the map never blanks.
//
// TIER-5 DISCIPLINE: coordinates render on the map and go nowhere else —
// nothing in the URL, nothing logged, one latest fix per vehicle, no
// trails.

export interface LiveMapProps {
  initialPositions: LatestPosition[];
  depots: DepotFence[];
  /** Vehicle ids carrying an ACTIVE, assigned tracker (register truth at
   *  page load) — splits fix-less vehicles into "No fix yet" vs "No
   *  tracker" in the sidebar. */
  trackedVehicleIds: string[];
  /** Total register rows at page load (drives the no-trackers empty state). */
  trackersRegistered: number;
}

const POLL_INTERVAL_MS = 20_000;

// Kathmandu — the fallback frame when nothing renders (the geofence-editor
// default), overridden by fit-to-content when markers/yards exist.
const DEFAULT_CENTER: L.LatLngExpression = [27.7172, 85.324];
const DEFAULT_ZOOM = 13;

// Marker colors resolve from the design tokens at mount (Leaflet writes SVG
// presentation attributes, where var() does not resolve, so the computed
// values are read once; the fallbacks are the same tokens' committed values
// in globals.css — no new token, DESIGN.md §"Live map"). fresh = accent,
// stale = warning; aging/dead are the existing zinc text tokens (the spec's
// "neutral marker" / "muted" — DESIGN.md's `color.status.neutral` wording
// binds to these zincs; no such standalone token exists in @theme).
const MARKER_TOKEN: Record<MarkerState, { cssVar: string; fallback: string }> = {
  fresh: { cssVar: "--color-accent-primary", fallback: "#059669" },
  aging: { cssVar: "--color-text-secondary", fallback: "#3f3f46" },
  stale: { cssVar: "--color-status-warning", fallback: "#f59e0b" },
  dead: { cssVar: "--color-text-muted", fallback: "#71717a" },
};

const MARKER_STATE_LABELS: Record<MarkerState, { label: string; range: string }> = {
  fresh: { label: "Fresh", range: "under 2 min" },
  aging: { label: "Aging", range: "2–15 min" },
  stale: { label: "Stale", range: "15 min – 24 h" },
  dead: { label: "Dead", range: "over 24 h" },
};

const MARKER_STATES: readonly MarkerState[] = ["fresh", "aging", "stale", "dead"];

function resolveMarkerColors(): Record<MarkerState, string> {
  const styles = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    MARKER_STATES.map((state) => {
      const { cssVar, fallback } = MARKER_TOKEN[state];
      const value = styles.getPropertyValue(cssVar).trim();
      return [state, value || fallback];
    }),
  ) as Record<MarkerState, string>;
}

// Stored m/s → displayed km/h, one decimal, em-dash when unknown (spec).
function formatSpeedKmh(speedMs: number | null): string {
  if (speedMs === null || !Number.isFinite(speedMs)) return "—";
  return `${(speedMs * 3.6).toFixed(1)} km/h`;
}

function formatIgnition(ignition: boolean | null): string {
  if (ignition === null) return "—";
  return ignition ? "On" : "Off";
}

// HH:MM:SS for the "last updated" poll line (local clock is fine here —
// it describes the POLL, not a fix; fix ages are server-computed).
function clockTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// Fit the map to the union of markers + yard polygons ONCE at mount; fall
// back to the Kathmandu default when nothing renders. Lives inside
// <MapContainer> so useMap() yields the instance. Deliberately not re-run
// on poll updates — the operator's pan/zoom must not be fought every 20 s.
function FitBoundsOnce({ points, rings }: { points: LatLngLike[]; rings: LatLngLike[][] }): null {
  const map = useMap();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const bounds = L.latLngBounds([]);
    for (const p of points) bounds.extend([p.lat, p.lng]);
    for (const ring of rings) for (const v of ring) bounds.extend([v.lat, v.lng]);
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
    }
  }, [map, points, rings]);

  return null;
}

export function LiveMap({
  initialPositions,
  depots,
  trackedVehicleIds,
  trackersRegistered,
}: LiveMapProps): React.ReactElement {
  const [positions, setPositions] = useState<LatestPosition[]>(initialPositions);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date>(() => new Date());
  const [pollFailed, setPollFailed] = useState(false);

  // Resolved once per mount (ssr:false — the document exists at render).
  const markerColors = useMemo(resolveMarkerColors, []);

  // Decode the yard rings once — depots are fetched per page load, not
  // polled (fence edits are rare; a reload picks them up).
  const yardRings = useMemo(
    () =>
      depots
        .map((d) => ({ ...d, ring: vertexInputToLatLngs(wktToVertexInput(d.boundaryWkt)) }))
        .filter((d) => d.ring.length >= 3),
    [depots],
  );

  const trackedIds = useMemo(() => new Set(trackedVehicleIds), [trackedVehicleIds]);

  const poll = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/api/v1/telematics/positions/latest`,
        { credentials: "include", cache: "no-store" },
      );
      if (!res.ok) throw new Error(`poll failed: ${res.status}`);
      const body = (await res.json()) as LatestPositionsResponse;
      setPositions(body.positions);
      setLastUpdatedAt(new Date());
      setPollFailed(false);
    } catch {
      // Keep the last markers; the sidebar states the network line. Nothing
      // is logged (Tier-5 discipline: no coordinates in the console, and a
      // failed poll carries none anyway).
      setPollFailed(true);
    }
  }, []);

  useEffect(() => {
    // Poll every 20 s while visible; on visibility return, fire immediately
    // and resume — the interval itself keeps running but skips hidden ticks
    // (cheaper than tearing the timer down and identical in behavior).
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void poll();
    }, POLL_INTERVAL_MS);
    function onVisibilityChange(): void {
      if (document.visibilityState !== "hidden") void poll();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [poll]);

  const withFix = positions.filter(
    (p): p is LatestPosition & { fix: NonNullable<LatestPosition["fix"]> } =>
      p.fix !== null && p.fixAgeSeconds !== null,
  );
  const withoutFix = positions.filter((p) => p.fix === null);

  const markerPoints: LatLngLike[] = withFix.map((p) => ({
    lat: p.fix.latitude,
    lng: p.fix.longitude,
  }));

  // The empty states, stated as fact (Voice): which one shows depends on
  // what exists, not what failed.
  let emptyStateLine: string | null = null;
  if (positions.length === 0) {
    emptyStateLine = "No vehicles registered.";
  } else if (trackersRegistered === 0) {
    emptyStateLine = "No trackers installed.";
  } else if (withFix.length === 0) {
    emptyStateLine = "No positions received yet.";
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* The map is the content — full-bleed in the container, not boxed
          into a card (DESIGN.md §"Live map"). */}
      <div className="border-border-subtle min-h-[70vh] flex-1 overflow-hidden rounded border shadow-sm">
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          scrollWheelZoom
          className="h-full min-h-[70vh] w-full"
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          <FitBoundsOnce points={markerPoints} rings={yardRings.map((y) => y.ring)} />

          {/* The yard: DEPOT fences, read-only — accent outline, faint
              fill, a name tooltip, no interaction beyond it. */}
          {yardRings.map((yard) => (
            <Polygon
              key={yard.id}
              positions={yard.ring.map((v) => [v.lat, v.lng] as [number, number])}
              pathOptions={{
                color: markerColors.fresh,
                weight: 2,
                fillColor: markerColors.fresh,
                fillOpacity: 0.1,
              }}
            >
              <Tooltip sticky>{yard.name}</Tooltip>
            </Polygon>
          ))}

          {/* One CircleMarker per vehicle-with-fix (an SVG path — colorable
              by token, no icon-asset pipeline), hue = server-computed fix
              age. The popup's age LABEL carries the meaning; the hue is
              recognition (anti-pattern #2). */}
          {withFix.map((p) => {
            const state = markerStateForAge(p.fixAgeSeconds ?? 0);
            const color = markerColors[state];
            return (
              <CircleMarker
                key={p.vehicleId}
                center={[p.fix.latitude, p.fix.longitude]}
                radius={9}
                pathOptions={{
                  color,
                  weight: 2,
                  fillColor: color,
                  fillOpacity: state === "dead" ? 0.35 : 0.8,
                }}
              >
                <Popup>
                  <div className="space-y-1 text-sm">
                    <p>
                      <a
                        href={`/vehicles/${p.vehicleId}`}
                        className="text-text-primary font-mono font-semibold underline-offset-2 hover:underline"
                      >
                        {p.registrationNumber}
                      </a>
                    </p>
                    <p className="text-text-secondary">
                      {VEHICLE_KIND_LABELS[p.kind] ?? p.kind} · {formatSpeedKmh(p.fix.speed)} ·
                      Ignition {formatIgnition(p.fix.ignition)}
                    </p>
                    {/* Age in words + the BS/AD date line. No coordinates
                        printed — they are already ON the map. */}
                    <p className="text-text-muted">
                      {fixAgeInWords(p.fixAgeSeconds ?? 0)} ·{" "}
                      {formatNepaliDate(p.fix.timestamp, { format: "both" })}
                    </p>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      {/* Sidebar: legend, poll line, untracked list — stacked below the map
          on small screens. */}
      <aside className="w-full shrink-0 space-y-4 lg:w-72">
        <section className="border-border-subtle bg-surface-raised rounded border p-4 shadow-sm">
          <h2 className="text-text-muted mb-3 text-xs font-medium tracking-wide uppercase">
            Fix age
          </h2>
          <ul className="space-y-2 text-sm">
            {MARKER_STATES.map((state) => (
              <li key={state} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded-full"
                  style={{
                    backgroundColor: markerColors[state],
                    opacity: state === "dead" ? 0.5 : 1,
                  }}
                />
                <span className="text-text-primary">{MARKER_STATE_LABELS[state].label}</span>
                <span className="text-text-muted ml-auto tabular-nums">
                  {MARKER_STATE_LABELS[state].range}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-text-muted mt-3 text-xs tabular-nums">
            Last updated {clockTime(lastUpdatedAt)} · refreshes every 20 s
          </p>
          {pollFailed ? (
            <p className="text-status-error mt-2 text-sm" role="alert">
              Cannot reach the server.{" "}
              <button
                type="button"
                onClick={() => void poll()}
                className="underline underline-offset-2"
              >
                Retry.
              </button>
            </p>
          ) : null}
        </section>

        <section className="border-border-subtle bg-surface-raised rounded border p-4 shadow-sm">
          <h2 className="text-text-muted mb-3 text-xs font-medium tracking-wide uppercase">
            Not on the map
          </h2>
          {emptyStateLine ? (
            <p className="text-text-secondary mb-2 text-sm">{emptyStateLine}</p>
          ) : null}
          {withoutFix.length === 0 && emptyStateLine === null ? (
            <p className="text-text-muted text-sm">Every vehicle has a fix.</p>
          ) : null}
          {withoutFix.length > 0 ? (
            <ul className="space-y-1.5 text-sm">
              {withoutFix.map((p) => (
                <li key={p.vehicleId} className="flex items-baseline justify-between gap-2">
                  <a
                    href={`/vehicles/${p.vehicleId}`}
                    className="text-text-primary font-mono underline-offset-2 hover:underline"
                  >
                    {p.registrationNumber}
                  </a>
                  <span className="text-text-muted">
                    {trackedIds.has(p.vehicleId) ? "No fix yet" : "No tracker"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </aside>
    </div>
  );
}
