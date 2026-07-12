import {
  type RoutePreviewResult,
  RoutingNotConfiguredError,
  RoutingProvider,
} from "./routing-provider";

/**
 * The env-gated placeholder for a LIVE routing provider (Google Directions/Routes
 * for a live-traffic ETA, or a self-hosted OSRM/OpenRouteService for a free-flow
 * ETA). ADR-0047 c9 ships the seam + the deterministic Mock in THIS program; the
 * live impl is M1-GATED ACTIVATION and is deliberately NOT built here (its
 * coordinate egress + per-request billing are recorded against ADR-0013 and
 * activated by the operator alongside the first deploy).
 *
 * Selecting a live `ROUTING_PROVIDER` name binds this stub. Its {@link route}
 * throws a clear {@link RoutingNotConfiguredError} so a mis-activation BEFORE the
 * live impl lands fails loudly rather than silently returning a Mock estimate the
 * operator would mistake for a real one. When the live impl is built (its own
 * ticket), it replaces this class in {@link routingProviderFactory}.
 */
export class LiveRoutingProviderStub extends RoutingProvider {
  constructor(
    private readonly providerName: string,
    private readonly apiKey: string | undefined,
  ) {
    super();
  }

  route(): Promise<RoutePreviewResult> {
    return Promise.reject(
      new RoutingNotConfiguredError(
        `Live routing provider "${this.providerName}" (API key ${
          this.apiKey !== undefined && this.apiKey !== "" ? "present" : "absent"
        }) is selected but not built in this program (ADR-0047 c9 — M1-gated ` +
          `activation). Unset ROUTING_PROVIDER to use the deterministic Mock.`,
      ),
    );
  }
}
