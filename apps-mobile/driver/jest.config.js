// jest-expo preset (SDK 56). Its transform chain (babel-preset-expo) handles
// TypeScript, so a pure .ts unit runs with no extra config. Component/render
// tests arrive with the real screens (D1+).
//
// W8 (ADR-0047) adds @maplibre/maplibre-react-native — a native map module
// jest-expo cannot load. No test imports the map island (src/trip-map.tsx), so
// the suite is green without this; the mapping is defensive so a FUTURE render
// test that imports the island resolves a lightweight stub (__mocks__/maplibre.tsx)
// rather than crashing on the native module. We COMPOSE the preset's own
// moduleNameMapper (the vector-icons aliases) instead of replacing it — a
// project-level moduleNameMapper overrides the preset's key wholesale otherwise.
const { moduleNameMapper } = require('jest-expo/jest-preset');

module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    ...moduleNameMapper,
    '^@maplibre/maplibre-react-native$': '<rootDir>/__mocks__/maplibre.tsx',
  },
};
