// Jest mock for @maplibre/maplibre-react-native (ADR-0047 W8). The real package
// is a NATIVE map module that jest-expo cannot load (its transformIgnorePatterns
// don't transform it, and it references native code). W8 keeps every map-consuming
// helper in pure modules (src/routing.ts) that tests import directly, so the suite
// is green without ever loading the island (src/trip-map.tsx). This stub exists
// only so a FUTURE component/render test that imports the island resolves here
// instead of crashing on the native module — each export is a pass-through view
// (or an inert null renderer). Wired via jest.config.js moduleNameMapper.
import * as React from "react";
import { View } from "react-native";

function Passthrough({ children }: { children?: React.ReactNode }): React.ReactElement {
  return <View>{children}</View>;
}

export const Map = Passthrough;
export const Marker = Passthrough;
export const GeoJSONSource = Passthrough;
export const Camera = (): null => null;
export const Layer = (): null => null;
