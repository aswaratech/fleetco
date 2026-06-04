"use client";

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import L from "leaflet";

import "leaflet/dist/leaflet.css";
import "@geoman-io/leaflet-geoman-free";
import "@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css";

import { ringToVertexInput, vertexInputToLatLngs, type LatLngLike } from "@/lib/geofence-latlng";

// The map-based polygon-drawing editor for a Geofence boundary (ADR-0030 G4,
// commitment 8 — the PO chose a map editor for v1; the Leaflet dependency is
// sanctioned there). It is a CLIENT-ONLY component: Leaflet references
// `window` at module load, so the forms import this via
// `next/dynamic(..., { ssr: false })` and it never renders on the server (the
// canonical Next.js App Router gotcha). The "use client" directive plus the
// dynamic ssr:false import are belt-and-braces.
//
// THE STORAGE CONTRACT IS UNCHANGED. The drawn ring serializes to the exact
// `lon,lat;lon,lat;…` vertex string the G3 coordinate-entry `boundary` field
// already produces and the API's shared PolygonParser validates — via the
// pure, unit-tested serializer in @/lib/geofence-latlng. The map is a richer
// input surface over the same representation, not a new one. The
// coordinate-entry field remains in both forms as the manual / fallback /
// headless-testable path; this editor and that field are kept in sync through
// a single source of truth (the form's `boundary` value): the editor receives
// it as `value` and writes back through `onChange`.
//
// Single-polygon discipline: a Geofence is one ring, so drawing a second
// polygon replaces the first (the prior layer is removed), and the polygon
// toolbar exposes draw / edit / remove only (no markers, lines, circles,
// rectangles, holes, drag, or rotate).

interface GeofenceMapEditorProps {
  /** The current boundary as the `lon,lat;…` vertex string (the form's value). */
  value: string;
  /** Called with the serialized `lon,lat;…` string whenever the drawn ring changes. */
  onChange: (next: string) => void;
}

// Kathmandu — a sensible default center for a Nepal fleet's first depot. Zoom
// 13 frames a city; the map fits to the stored boundary on the edit form, so
// this default only matters for a brand-new fence.
const DEFAULT_CENTER: L.LatLngExpression = [27.7172, 85.324];
const DEFAULT_ZOOM = 13;

// Flatten Leaflet's nested ring structure (getLatLngs() returns LatLng[],
// LatLng[][], or LatLng[][][] depending on holes/multipolygons) down to a
// flat list of plain { lat, lng }. A Geofence is a hole-less single polygon,
// so the outer ring is all there is; flattening is a robust read either way.
type NestedLatLngs = L.LatLng | L.LatLng[] | L.LatLng[][] | L.LatLng[][][];

function flattenLatLngs(node: NestedLatLngs): LatLngLike[] {
  if (Array.isArray(node)) {
    return node.flatMap(flattenLatLngs);
  }
  return [{ lat: node.lat, lng: node.lng }];
}

// The drawing controller. Lives INSIDE <MapContainer> so useMap() yields the
// Leaflet map instance; it wires Geoman, manages the single editable polygon,
// and keeps the form's `boundary` value in sync with the drawn ring.
function PolygonDrawController({ value, onChange }: GeofenceMapEditorProps): null {
  const map = useMap();

  // The current editable polygon layer, or null when none is drawn.
  const layerRef = useRef<L.Polygon | null>(null);
  // The last `lon,lat;…` string THIS component emitted (or synced from an
  // external edit). Used to break the echo loop: when `value` changes because
  // we just called onChange, it equals lastEmitted and we skip re-rendering.
  const lastEmittedRef = useRef<string>(value);
  // Keep the latest onChange without re-running the setup effect.
  const onChangeRef = useRef(onChange);
  // The boundary at mount, captured once for the initial render (edit-form
  // pre-fill). useRef seeds from the first render's value and never updates.
  const initialValueRef = useRef(value);
  // Bridges the setup effect (which owns the imperative render-from-value
  // closure) to the [value] effect below, so an external coordinate-field
  // edit can re-render the map without duplicating the Leaflet wiring.
  const syncRef = useRef<((next: string) => void) | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Stable callbacks (the map instance is stable for the component's life, so
  // a [map] dependency makes these identity-stable across renders).
  useEffect(() => {
    function emit(): void {
      const layer = layerRef.current;
      const next = layer ? ringToVertexInput(flattenLatLngs(layer.getLatLngs())) : "";
      lastEmittedRef.current = next;
      onChangeRef.current(next);
    }

    function removeCurrentLayer(): void {
      const layer = layerRef.current;
      if (layer) {
        layer.off();
        map.removeLayer(layer);
        layerRef.current = null;
      }
    }

    function trackLayer(layer: L.Polygon): void {
      layerRef.current = layer;
      // pm:edit fires live as a vertex is dragged; pm:update on edit-commit.
      // Both re-serialize so the form's boundary tracks the drawn shape.
      layer.on("pm:edit", emit);
      layer.on("pm:update", emit);
    }

    function renderFromValue(next: string, fit: boolean): void {
      removeCurrentLayer();
      const latlngs = vertexInputToLatLngs(next);
      if (latlngs.length >= 3) {
        const layer = L.polygon(latlngs);
        layer.addTo(map);
        trackLayer(layer);
        if (fit) {
          map.fitBounds(layer.getBounds(), { padding: [24, 24], maxZoom: 17 });
        }
      }
      // Record what we rendered so the value-sync effect treats it as already
      // applied (no echo). This is NOT an emit — initial/external renders must
      // not mark the form dirty or fight the user's typing.
      lastEmittedRef.current = next;
    }

    const onCreate: L.PM.CreateEventHandler = (e) => {
      if (!(e.layer instanceof L.Polygon)) {
        return;
      }
      // Single-polygon: a freshly drawn ring replaces any prior one.
      if (layerRef.current && layerRef.current !== e.layer) {
        removeCurrentLayer();
      }
      trackLayer(e.layer);
      emit();
    };

    const onRemove: L.PM.RemoveEventHandler = (e) => {
      // Geoman has already removed the layer from the map; just drop our ref
      // and clear the boundary so the form's required-rule re-fires.
      if (e.layer === layerRef.current) {
        layerRef.current = null;
        lastEmittedRef.current = "";
        onChangeRef.current("");
      }
    };

    map.pm.addControls({
      position: "topleft",
      drawMarker: false,
      drawCircleMarker: false,
      drawPolyline: false,
      drawRectangle: false,
      drawCircle: false,
      drawText: false,
      drawPolygon: true,
      editMode: true,
      dragMode: false,
      cutPolygon: false,
      removalMode: true,
      rotateMode: false,
    });
    map.on("pm:create", onCreate);
    map.on("pm:remove", onRemove);

    // Initial render: draw the pre-filled boundary (edit form) and frame it.
    renderFromValue(initialValueRef.current, true);

    // The value-sync handler is registered as a Leaflet-independent closure on
    // a ref so the separate [value] effect can call it; see below.
    syncRef.current = (next: string) => {
      if (next === lastEmittedRef.current) {
        return;
      }
      renderFromValue(next, false);
    };

    return () => {
      map.off("pm:create", onCreate);
      map.off("pm:remove", onRemove);
      removeCurrentLayer();
      map.pm.removeControls();
      syncRef.current = null;
    };
  }, [map]);

  // External edits to the coordinate-entry field flow in as `value` changes.
  // Re-render the map polygon from them (guarded against our own echo inside
  // syncRef). We don't refit on every keystroke — only the initial mount
  // frames the map — so manual typing doesn't make the viewport jump.
  useEffect(() => {
    syncRef.current?.(value);
  }, [value]);

  return null;
}

/**
 * Client-only Leaflet polygon editor for a Geofence boundary. Renders an
 * OpenStreetMap raster basemap (no API key) with a Geoman polygon draw / edit
 * / remove toolbar; the drawn ring is serialized to the `lon,lat;…`
 * representation via `onChange`. Import through `next/dynamic(..., { ssr:
 * false })`.
 */
export function GeofenceMapEditor({ value, onChange }: GeofenceMapEditorProps): React.ReactElement {
  return (
    <div className="border-border-subtle overflow-hidden rounded-md border">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom
        className="h-80 w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <PolygonDrawController value={value} onChange={onChange} />
      </MapContainer>
    </div>
  );
}

export default GeofenceMapEditor;
