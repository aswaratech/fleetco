import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { SitesController } from "./sites.controller";
import { SitesService } from "./sites.service";

// SitesModule — the reusable pinned-location aggregate (ADR-0047 c4). Owns the
// Site model: a geographic PIN (crusher / pit / delivery site / depot) a
// dispatch picks as a Trip's pickup or drop-off. "Define once, reuse forever"
// for a single company that hauls the same lanes over and over.
//
// AuthModule is imported (not just AuthGuard listed in providers) so the AUTH
// provider is available to the guard at request time — see AuthModule's exports
// ([AUTH, AuthGuard]) and ADR-0021 §6. Same pattern Customers / Geofences /
// Trips follow.
//
// SitesService is exported so the W4 Trip dispatch module (and any other module
// that needs a site lookup) can findById a Site to validate a pickup/drop-off
// reference without a circular import through the controller layer — exactly as
// CustomersModule exports CustomersService for the Jobs slice.
@Module({
  imports: [AuthModule],
  controllers: [SitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
