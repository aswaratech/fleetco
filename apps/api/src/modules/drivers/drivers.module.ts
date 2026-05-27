import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { TripsModule } from "../trips/trips.module";
import { DriversController } from "./drivers.controller";
import { DriversService } from "./drivers.service";

// DriversModule — second Phase 1 vertical slice per the roadmap.
// Owns the Driver aggregate; the Trip slice FKs Driver alongside
// Vehicle per ADR-0003. AuthModule is imported (not just AuthGuard
// listed in providers) so the AUTH provider is available to the guard
// at request time — see AuthModule's exports ([AUTH, AuthGuard]) and
// ADR-0021 §6. DriversService is exported so the Trips module (and any
// future module) can findById drivers without a circular import
// through the controller layer.
//
// TripsModule is imported so DriversController can call
// `TripsService.statsForDriver()` from the iter-13 `GET :id/stats`
// route. The aggregation lives in TripsService because the underlying
// data is Trip rows; this module pulls it in rather than duplicating
// the query. The two modules' dependency direction is acyclic:
// TripsModule references the Driver table directly through Prisma's
// schema (no TypeScript dependency on this module). Mirror of the
// iter-12 VehiclesModule wiring to TripsModule.
@Module({
  imports: [AuthModule, TripsModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
