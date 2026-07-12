import { describe, expect, it } from "@jest/globals";

import { TripMap } from "./trip-map";

// Proves the MapLibre native module is mocked end-to-end (jest.config.js
// moduleNameMapper → __mocks__/maplibre.tsx): importing the map island must NOT
// crash the jest-expo suite on the native module. We assert only that the
// component is importable + callable — the map's real rendering is a device
// concern (the custom dev build), outside the network-free / binary-free CI gate
// (ADR-0033 c4). Without the mock, this import throws on the native module.
describe("TripMap import (native MapLibre module mocked)", () => {
  it("imports the map island without loading the native module", () => {
    expect(typeof TripMap).toBe("function");
  });
});
