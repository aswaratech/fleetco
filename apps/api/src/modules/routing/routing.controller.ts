import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import { RoutePreviewSchema, type RoutePreviewInput } from "./routing.schemas";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- RoutingProvider is a runtime DI token
import { RoutingProvider, type RoutePreviewResult } from "./routing-provider";

/**
 * RoutingController — the admin dispatch map's route-preview endpoint (ADR-0047
 * c9). It resolves a pickup→drop-off polyline + estimated distance/duration from
 * the injected {@link RoutingProvider} seam (the Mock in dev/test/CI, a live impl
 * at M1). Gated on the existing `trips:*` capability via the composed
 * AuthGuard + RolesGuard chain (ADR-0028 c5) — dispatch is a trips concern, and
 * only the roles that can see trips can preview their routes.
 *
 * The controller injects ONLY the provider (no Prisma, no Trip access): the web
 * supplies the two site coordinates it already holds from the trip detail, so
 * this module stays fully decoupled from the Trip aggregate and adds no
 * constructor dependency to TripsService (no DI-ripple).
 */
@Controller("api/v1/routing")
@RequirePermission("trips:*")
@UseGuards(AuthGuard, RolesGuard)
export class RoutingController {
  constructor(private readonly routing: RoutingProvider) {}

  @Post("route-preview")
  @HttpCode(HttpStatus.OK)
  async routePreview(
    @Body(new ZodValidationPipe(RoutePreviewSchema)) body: RoutePreviewInput,
  ): Promise<RoutePreviewResult> {
    return this.routing.route(body.origin, body.destination);
  }
}
