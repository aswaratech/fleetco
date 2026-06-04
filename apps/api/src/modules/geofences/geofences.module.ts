import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { GeofencesController } from "./geofences.controller";
import { GeofencesService } from "./geofences.service";

// GeofencesModule — the geofence-configuration aggregate (ADR-0030). Owns the
// first PostGIS geometry(Polygon, 4326) in FleetCo: a company-defined boundary
// (depot yard / customer site / route corridor) the telematics derived-read
// layer classifies a vehicle's latest fix against. The G1 schema slice shipped
// the model + hand-authored generated-column migration; this module (G2) adds
// the service / controller / RBAC layer.
//
// AuthModule is imported (not just the guards listed in providers) so the AUTH
// provider, AuthGuard, AND RolesGuard are available to the controller's
// composed `@UseGuards(AuthGuard, RolesGuard)` chain at request time — see
// AuthModule's exports ([AUTH, AuthGuard, RolesGuard]) and ADR-0021 §6 /
// ADR-0028 c5. The read/write capability split (geofences:read / :write) lives
// in permissions.ts; the controller gates each route with @RequirePermission.
//
// GeofencesService is exported so the forthcoming G5 wiring (reading a stored
// fence into the telematics geofence-status query) can fetch a fence by id
// without a circular import through the controller layer — the same convention
// every vertical-slice module follows.
@Module({
  imports: [AuthModule],
  controllers: [GeofencesController],
  providers: [GeofencesService],
  exports: [GeofencesService],
})
export class GeofencesModule {}
