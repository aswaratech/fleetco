import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { TripsController } from "./trips.controller";
import { TripsService } from "./trips.service";

// TripsModule — third Phase 1 vertical slice per the roadmap, and the
// central aggregate of the FleetCo domain per ADR-0003 (one trip = one
// contiguous use of one Vehicle by one Driver with start/end odometer
// and timestamps). Vehicles (iter 1-2, 4-5) and Drivers (iter 6-7)
// exist precisely so this aggregate can reference them by id.
//
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6.
// TripsService is exported so future modules (e.g., a Reports module
// in a later phase) can call it without a circular import through the
// controller layer. The Vehicles and Drivers slices export their
// services for the same reason.
@Module({
  imports: [AuthModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
