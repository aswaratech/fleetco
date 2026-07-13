"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";

import "leaflet/dist/leaflet.css";

import { fixAgeInWords, markerStateForAge, type MarkerState } from "@/lib/map-markers";

// The read-only trip-detail tracking map (ADR-0047 c9, DESIGN §"Trip dispatch"):
// the assigned vehicle's latest fix (with the /map fix-age honesty), the pickup
// and drop-off pins, and — when the RoutingProvider returns geometry — the
// pickup→drop-off route polyline. No trails (Tier-5 discipline): one fix, two
// pins, one route line. Reuses the sanctioned Leaflet + OSM stack; it is loaded
// via next/dynamic { ssr: false } (Leaflet touches window at module load).

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_CENTER: L.LatLngExpression = [27.7172, 85.324];
const DEFAULT_ZOOM = 12;

export interface TripMapFix {
  latitude: number;
  longitude: number;
  fixAgeSeconds: number;
  registrationNumber: string;
}

export interface TripMapSite {
  latitude: number;
  longitude: number;
  name: string;
}

export interface TripMapProps {
  vehicleFix: TripMapFix | null;
  pickup: TripMapSite | null;
  dropoff: TripMapSite | null;
  routeGeometry: [number, number][] | null;
}

// The vehicle-fix hue token per fix-age state (mirrors live-map's
// resolveMarkerColors): Leaflet writes SVG presentation attributes where CSS
// var() does not resolve, so read the computed token once at mount with a
// committed-hex fallback and feed the resolved string into pathOptions.
const MARKER_TOKEN: Record<MarkerState, { cssVar: string; fallback: string }> = {
  fresh: { cssVar: "--color-accent-primary", fallback: "#059669" },
  aging: { cssVar: "--color-text-secondary", fallback: "#3f3f46" },
  stale: { cssVar: "--color-status-warning", fallback: "#f59e0b" },
  dead: { cssVar: "--color-text-muted", fallback: "#71717a" },
};

function resolveVar(cssVar: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return value || fallback;
}

// A teardrop pin divIcon in a given CSS-var color. var() DOES resolve inside the
// divIcon HTML (custom properties cascade into the Leaflet marker pane), unlike
// pathOptions — so this uses no Tailwind class token and the design-token
// consumption sweep stays green. The tip sits on the coordinate (iconAnchor).
function pinDivIcon(colorVar: string, fallback: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html:
      `<span style="color: var(${colorVar}, ${fallback}); ` +
      `filter: drop-shadow(0 1px 1px rgba(0,0,0,0.35)); display: block; line-height: 0;">` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" ` +
      `fill="currentColor" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" ` +
      `stroke-linejoin="round">` +
      `<path d="M12 21s7-6.13 7-11a7 7 0 1 0-14 0c0 4.87 7 11 7 11z"/>` +
      `<circle cx="12" cy="10" r="2.5" fill="#ffffff" stroke="none"/></svg></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
  });
}

// Fit the frame to all points ONCE (a doneRef guard) so an operator's pan/zoom
// is not fought on re-render. Lives inside <MapContainer> so useMap() resolves.
function FitBoundsOnce({ points }: { points: [number, number][] }): null {
  const map = useMap();
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (points.length === 0) return;
    const bounds = L.latLngBounds(points);
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
  }, [map, points]);
  return null;
}

export function TripMap({
  vehicleFix,
  pickup,
  dropoff,
  routeGeometry,
}: TripMapProps): React.ReactElement {
  const vehicleColor = useMemo(() => {
    if (!vehicleFix) return null;
    const { cssVar, fallback } = MARKER_TOKEN[markerStateForAge(vehicleFix.fixAgeSeconds)];
    return resolveVar(cssVar, fallback);
  }, [vehicleFix]);
  const routeColor = useMemo(() => resolveVar("--color-accent-primary", "#059669"), []);
  const pickupIcon = useMemo(() => pinDivIcon("--color-accent-primary", "#059669"), []);
  const dropoffIcon = useMemo(() => pinDivIcon("--color-status-info", "#2563eb"), []);

  const points: [number, number][] = [];
  if (vehicleFix) points.push([vehicleFix.latitude, vehicleFix.longitude]);
  if (pickup) points.push([pickup.latitude, pickup.longitude]);
  if (dropoff) points.push([dropoff.latitude, dropoff.longitude]);
  const center: L.LatLngExpression = points[0] ?? DEFAULT_CENTER;

  return (
    <div className="border-border-subtle overflow-hidden rounded-md border">
      <MapContainer center={center} zoom={DEFAULT_ZOOM} scrollWheelZoom className="h-72 w-full">
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
        {routeGeometry && routeGeometry.length > 1 ? (
          <Polyline
            positions={routeGeometry}
            pathOptions={{ color: routeColor, weight: 3, opacity: 0.75, dashArray: "6 8" }}
          />
        ) : null}
        {pickup ? (
          <Marker position={[pickup.latitude, pickup.longitude]} icon={pickupIcon}>
            <Tooltip>Pickup · {pickup.name}</Tooltip>
          </Marker>
        ) : null}
        {dropoff ? (
          <Marker position={[dropoff.latitude, dropoff.longitude]} icon={dropoffIcon}>
            <Tooltip>Drop-off · {dropoff.name}</Tooltip>
          </Marker>
        ) : null}
        {vehicleFix && vehicleColor ? (
          <CircleMarker
            center={[vehicleFix.latitude, vehicleFix.longitude]}
            radius={9}
            pathOptions={{
              color: vehicleColor,
              weight: 2,
              fillColor: vehicleColor,
              fillOpacity: 0.8,
            }}
          >
            <Popup>
              {vehicleFix.registrationNumber} · {fixAgeInWords(vehicleFix.fixAgeSeconds)}
            </Popup>
          </CircleMarker>
        ) : null}
        <FitBoundsOnce points={points} />
      </MapContainer>
    </div>
  );
}
