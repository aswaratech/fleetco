/**
 * RoutingProvider — the provider-agnostic route-preview seam (ADR-0047 c9),
 * mirroring the Mailer-over-`resend` / LlmClient-over-DeepSeek pattern
 * file-for-file: own the seam, isolate the vendor.
 *
 * WHY AN ABSTRACT CLASS, NOT A BARE `interface`: NestJS resolves providers by a
 * runtime token, and a TypeScript `interface` does not exist at runtime. An
 * abstract class is BOTH the compile-time contract AND a runtime DI token, so
 * the module can wire `{ provide: RoutingProvider, useFactory: … }` (the Mock in
 * dev/test/CI, a live impl at M1) and the controller can
 * `constructor(private readonly routing: RoutingProvider)`.
 *
 * The dispatch map (W6) draws a pickup→drop-off polyline and an estimated
 * "~45 min · 32 km" label from `route()`. The estimate is a PREVIEW; the
 * driver's authoritative turn-by-turn is always the Google-Maps deep-link (W7).
 * Coordinate egress to a LIVE provider is recorded in ADR-0013 (via ADR-0047)
 * and gated on M1 — the Mock shipped here makes ZERO egress.
 */

/** A geographic point. `lat` in [-90, 90], `lng` in [-180, 180]. */
export interface LatLng {
  lat: number;
  lng: number;
}

export interface RoutePreviewResult {
  /**
   * The route polyline as `[lat, lng]` pairs — Leaflet-ready (a `Polyline`
   * consumes `LatLngExpression[]`, i.e. `[lat, lng][]`), so the web needs no
   * polyline decode. The first pair equals `origin`, the last equals
   * `destination`.
   */
  geometryLatLng: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
}

export abstract class RoutingProvider {
  abstract route(
    origin: LatLng,
    destination: LatLng,
    opts?: { signal?: AbortSignal },
  ): Promise<RoutePreviewResult>;
}

/**
 * Thrown when a route preview is requested but no provider can serve it — e.g. a
 * live `ROUTING_PROVIDER` is selected whose impl is not built yet (M1-gated). The
 * route-preview endpoint and the web degrade gracefully (pins without a route
 * line) rather than surfacing this as a hard error to the operator.
 */
export class RoutingNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingNotConfiguredError";
  }
}
