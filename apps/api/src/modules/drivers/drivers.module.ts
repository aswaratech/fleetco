import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { DriversController } from "./drivers.controller";
import { DriversService } from "./drivers.service";

// DriversModule — second Phase 1 vertical slice per the roadmap.
// Owns the Driver aggregate; the Trip slice will FK Driver alongside
// Vehicle per ADR-0003. AuthModule is imported (not just AuthGuard
// listed in providers) so the AUTH provider is available to the guard
// at request time — see AuthModule's exports ([AUTH, AuthGuard]) and
// ADR-0021 §6. DriversService is exported so the future Trips module
// can findById drivers during trip creation without a circular import
// through the controller layer.
@Module({
  imports: [AuthModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
