// The driver order-detail inline map (ADR-0047 c9, W8): the pickup + drop-off
// pins and — when the route preview resolved — the pickup→drop-off route
// polyline, on an OSM raster basemap (no API key). It is a PREVIEW; the driver's
// authoritative turn-by-turn is the Navigate deep-link (W7), never this map.
//
// MapLibre-RN is a NATIVE module behind the custom dev build (Expo Go cannot run
// it), like the D4/D5 GPS work. A test never imports this file — the pure
// map-prep helpers it renders from live in src/routing.ts (tested there), and
// jest maps the native module to a stub (__mocks__/maplibre.tsx). Keep this file
// thin: coordinate math and formatting stay in routing.ts.
import * as React from "react";
import { StyleSheet, View } from "react-native";
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type StyleSpecification,
} from "@maplibre/maplibre-react-native";

import { boundsForPins, routeLineString, type MapPoint } from "./routing";

// OSM raster basemap as an inline MapLibre style — no API key, no vector tiles,
// matching the web's OSM tiles (ADR-0047 c9). One raster source + one raster
// layer; MapLibre needs no token for public OSM tiles.
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm-raster", type: "raster", source: "osm" }],
};

// Pin + route hues, inline (this standalone app has no design-token pipeline):
// pickup green / drop-off blue mirror the web trip map's pickup/drop-off marker
// colors, and the route line reuses the in-app blue.
const PICKUP_COLOR = "#059669";
const DROPOFF_COLOR = "#1f6feb";
const ROUTE_COLOR = "#1f6feb";

export interface TripMapPin extends MapPoint {
  name: string;
}

export interface TripMapProps {
  pickup: TripMapPin;
  dropoff: TripMapPin;
  // The API's [lat, lng] polyline, or null when the preview failed / is absent
  // (the pins still render; graceful absence, no route line).
  routeGeometryLatLng: [number, number][] | null;
}

function PinDot({ color }: { color: string }): React.ReactElement {
  return <View style={[styles.pin, { backgroundColor: color }]} />;
}

export function TripMap({
  pickup,
  dropoff,
  routeGeometryLatLng,
}: TripMapProps): React.ReactElement {
  // The camera frames both pins ONCE on load (initialViewState, not a controlled
  // camera) so the driver's own pan/zoom is never fought.
  const bounds = boundsForPins(pickup, dropoff);
  // MapLibre wants [lng, lat]; the API returns [lat, lng] — the swap lives in
  // routeLineString (routing.ts), which returns null for a degenerate geometry.
  const line = routeGeometryLatLng ? routeLineString(routeGeometryLatLng) : null;

  return (
    <View style={styles.wrap}>
      <Map style={styles.map} mapStyle={OSM_STYLE}>
        <Camera initialViewState={{ bounds }} />
        {line ? (
          <GeoJSONSource id="route" data={line}>
            <Layer
              id="route-line"
              type="line"
              paint={{ "line-color": ROUTE_COLOR, "line-width": 4, "line-opacity": 0.75 }}
            />
          </GeoJSONSource>
        ) : null}
        <Marker id="pickup" lngLat={[pickup.longitude, pickup.latitude]}>
          <PinDot color={PICKUP_COLOR} />
        </Marker>
        <Marker id="dropoff" lngLat={[dropoff.longitude, dropoff.latitude]}>
          <PinDot color={DROPOFF_COLOR} />
        </Marker>
      </Map>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: 220,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#e2e2e2",
  },
  map: {
    flex: 1,
  },
  pin: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: "#fff",
  },
});
