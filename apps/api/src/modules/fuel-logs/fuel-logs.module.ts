import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { FuelLogsController } from "./fuel-logs.controller";
import { FuelLogsService } from "./fuel-logs.service";

// FuelLogsModule — sixth Phase 1 vertical slice per the roadmap.
// Downstream of Vehicles (iter 1) and Trips (iter 8): a FuelLog
// references a Vehicle (required) and optionally a Trip. Same module
// shape as JobsModule / TripsModule / CustomersModule.
//
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6.
//
// FuelLogsService is exported so future modules (e.g., a per-vehicle
// km/L stats slice, or a Reports module) can call it without a
// circular import through the controller layer. Every other vertical-
// slice module exports its service for the same reason.
@Module({
  imports: [AuthModule],
  controllers: [FuelLogsController],
  providers: [FuelLogsService],
  exports: [FuelLogsService],
})
export class FuelLogsModule {}
