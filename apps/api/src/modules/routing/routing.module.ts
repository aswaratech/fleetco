import { Module } from "@nestjs/common";

import { env } from "../../config/env";
import { AuthModule } from "../auth/auth.module";
import { LiveRoutingProviderStub } from "./live.routing-provider";
import { MockRoutingProvider } from "./mock.routing-provider";
import { RoutingController } from "./routing.controller";
import { RoutingProvider } from "./routing-provider";

// RoutingModule — the provider-agnostic route-preview seam (ADR-0047 c9),
// mirroring AgentModule's LlmClient DI: the abstract `RoutingProvider` token
// resolves to the no-network MockRoutingProvider whenever no live
// `ROUTING_PROVIDER` is selected (dev / test / CI — zero egress, no key), and to
// the LiveRoutingProviderStub when a live provider name is set (M1-gated
// activation; the stub fails loudly until the live impl is built). The selection
// lives in the exported `routingProviderFactory` (explicit-argument,
// deterministic) so it is unit-testable regardless of ambient env; the module
// wires it to the typed env exactly as the LlmClient factory reads
// DEEPSEEK_API_KEY.
//
// AuthModule is imported (the trips/agent precedent) so the AUTH provider,
// AuthGuard, AND RolesGuard are available to the controller's composed
// `@UseGuards(AuthGuard, RolesGuard)` chain at request time.

/**
 * Choose the RoutingProvider implementation for a given provider name + key.
 * Exported for the deterministic factory-selection test; the module applies it
 * to `env.ROUTING_PROVIDER` / `env.ROUTING_API_KEY`.
 */
export function routingProviderFactory(
  providerName: string | undefined,
  apiKey: string | undefined,
): RoutingProvider {
  const name = (providerName ?? "").trim().toLowerCase();
  if (name === "" || name === "mock") {
    return new MockRoutingProvider();
  }
  return new LiveRoutingProviderStub(name, apiKey);
}

@Module({
  imports: [AuthModule],
  controllers: [RoutingController],
  providers: [
    {
      provide: RoutingProvider,
      useFactory: (): RoutingProvider =>
        routingProviderFactory(env.ROUTING_PROVIDER, env.ROUTING_API_KEY),
    },
  ],
  exports: [RoutingProvider],
})
export class RoutingModule {}
