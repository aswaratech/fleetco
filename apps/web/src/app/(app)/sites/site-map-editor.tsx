"use client";

import { useEffect, useRef } from "react";
import { MapContainer, Marker, TileLayer, Tooltip, useMapEvents } from "react-leaflet";
import L from "leaflet";

import "leaflet/dist/leaflet.css";

import { formatCoord, parseLatLng } from "@/lib/sites-schema";

// The map-based single-marker pin editor for a Site (ADR-0047 W5, c4/c9 — "drop
// a pin on the map, name it → a reusable Site"). A CLIENT-ONLY component:
// Leaflet references `window` at module load, so the forms import this via
// next/dynamic({ ssr: false }) and the detail page imports it through the
// site-map-view.tsx loader — it never renders on the server (the canonical
// Next.js App Router gotcha). The "use client" directive plus the dynamic
// ssr:false import are belt-and-braces.
//
// It is the single-POINT analogue of geofence-map-editor.tsx (which draws a
// Geoman polygon). A Site is one geographic pin, so there is no polygon toolbar
// and no Geoman at all: the operator clicks the map to drop/move ONE marker, or
// drags it to fine-tune. The marker's position writes the form's `latitude` /
// `longitude` string fields (via onChange), and typing into those fields
// re-positions the marker — one source of truth (the form's coordinate values),
// the same two-way contract the geofence editor keeps with its coordinate
// textarea.
//
// THE X,Y FOOT-GUN: Leaflet's LatLng is { lat, lng } — latitude first — while
// the Site API takes SEPARATE `latitude` / `longitude` scalars. The mapping is
// explicit here (marker.lat → latitude, marker.lng → longitude); parseLatLng
// returns the [lat, lng] tuple Leaflet expects and formatCoord tidies the float
// noise. Both are pure and unit-tested in sites-schema.test.ts.
//
// THE MARKER ICON: FleetCo avoids Leaflet's default PNG icon (it 404s under a
// bundler — the live map uses a CircleMarker for exactly this reason). Here we
// need a DRAGGABLE marker (a CircleMarker is not draggable), so we use an
// inline-SVG divIcon whose color reads `var(--color-accent-primary)` — a live
// @theme token (with the committed emerald as a fallback, the live-map
// convention). No icon asset ships and no new design token is introduced, so
// globals.css's @theme stays untouched and the token-drift/consumption tests
// stay green.

// Kathmandu — the default frame for a brand-new pin (the geofence-editor
// default). A pre-filled position (edit form / detail view) frames the pin
// instead, via the MapContainer center below.
const DEFAULT_CENTER: L.LatLngExpression = [27.7172, 85.324];
const DEFAULT_ZOOM = 13;
// A single pin frames tighter than a whole city.
const PIN_ZOOM = 15;

// A teardrop map-pin as an inline-SVG divIcon. `color` resolves the live
// accent-primary @theme token (CSS custom properties cascade into the Leaflet
// marker pane, which lives in the document); the committed emerald #059669 is
// the fallback, matching live-map.tsx's token-with-fallback discipline. The
// anchor is the tip (bottom-center) so the point sits exactly on the coordinate.
function siteDivIcon(): L.DivIcon {
  return L.divIcon({
    // Empty className suppresses Leaflet's default white-box divIcon styling.
    className: "",
    html:
      `<span style="color: var(--color-accent-primary, #059669); ` +
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

const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

interface SiteMapEditorProps {
  /** The current latitude as the form's string value ("" when unset). */
  latitude: string;
  /** The current longitude as the form's string value ("" when unset). */
  longitude: string;
  /** Called with the formatted (latitude, longitude) strings when the marker moves. */
  onChange: (latitude: string, longitude: string) => void;
}

// The click/drag controller. Lives INSIDE <MapContainer>. A map click drops or
// moves the single marker; dragging the marker fine-tunes it. Both emit the
// formatted coordinates through onChange, which the form writes back to its
// latitude/longitude fields — re-rendering this marker at the new position
// (declarative; no imperative re-draw, so no echo loop).
function MarkerController({
  latitude,
  longitude,
  onChange,
}: SiteMapEditorProps): React.ReactElement | null {
  const position = parseLatLng(latitude, longitude);
  // Keep the latest onChange without resubscribing the map events each render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useMapEvents({
    click(e) {
      onChangeRef.current(formatCoord(e.latlng.lat), formatCoord(e.latlng.lng));
    },
  });

  if (position === null) return null;

  return (
    <Marker
      position={position}
      draggable
      icon={siteDivIcon()}
      eventHandlers={{
        dragend(e) {
          const ll = (e.target as L.Marker).getLatLng();
          onChangeRef.current(formatCoord(ll.lat), formatCoord(ll.lng));
        },
      }}
    />
  );
}

/**
 * Client-only Leaflet single-marker pin editor for a Site's location. Renders
 * an OpenStreetMap raster basemap (no API key, Kathmandu default) with a
 * draggable pin: click the map to drop/move it, drag to fine-tune. The marker's
 * position is written back through onChange as formatted lat/lng strings. A
 * pre-filled position (the edit form) frames the stored pin at mount. Import
 * through next/dynamic({ ssr: false }).
 */
export function SiteMapEditor({
  latitude,
  longitude,
  onChange,
}: SiteMapEditorProps): React.ReactElement {
  const position = parseLatLng(latitude, longitude);
  return (
    <div className="border-border-subtle overflow-hidden rounded-md border">
      <MapContainer
        center={position ?? DEFAULT_CENTER}
        zoom={position ? PIN_ZOOM : DEFAULT_ZOOM}
        scrollWheelZoom
        className="h-80 w-full"
      >
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
        <MarkerController latitude={latitude} longitude={longitude} onChange={onChange} />
      </MapContainer>
    </div>
  );
}

interface SiteMapViewProps {
  latitude: number;
  longitude: number;
  name: string;
}

/**
 * Client-only read-only single-marker map for the Site detail page. Same OSM
 * basemap and pin as the editor, centered on the stored coordinate, with the
 * site name as a tooltip. No click/drag. Import through next/dynamic({ ssr:
 * false }) via site-map-view.tsx.
 */
export function SiteMapView({ latitude, longitude, name }: SiteMapViewProps): React.ReactElement {
  const position: [number, number] = [latitude, longitude];
  return (
    <div className="border-border-subtle overflow-hidden rounded-md border">
      <MapContainer center={position} zoom={PIN_ZOOM} scrollWheelZoom className="h-72 w-full">
        <TileLayer attribution={TILE_ATTRIBUTION} url={TILE_URL} />
        <Marker position={position} icon={siteDivIcon()}>
          <Tooltip>{name}</Tooltip>
        </Marker>
      </MapContainer>
    </div>
  );
}

export default SiteMapEditor;
