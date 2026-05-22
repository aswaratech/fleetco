import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { VehiclesController } from "./vehicles.controller";
import { VehiclesService } from "./vehicles.service";

// VehiclesModule — first Phase 1 vertical slice per the roadmap.
// Owns the Vehicle aggregate; downstream slices (Drivers, Trips, etc.)
// reference Vehicle by id per ADR-0003 (Trip as central aggregate).
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6.
@Module({
  imports: [AuthModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
