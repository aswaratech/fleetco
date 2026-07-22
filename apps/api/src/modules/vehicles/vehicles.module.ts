import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { DocumentsModule } from "../documents/documents.module";
import { TripsModule } from "../trips/trips.module";
import { RenewalsController } from "./renewals.controller";
import { RenewalsService } from "./renewals.service";
import { VehiclesController } from "./vehicles.controller";
import { VehiclesService } from "./vehicles.service";

// VehiclesModule — first Phase 1 vertical slice per the roadmap.
// Owns the Vehicle aggregate; downstream slices (Drivers, Trips, etc.)
// reference Vehicle by id per ADR-0003 (Trip as central aggregate).
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6.
//
// TripsModule is imported so VehiclesController can call
// `TripsService.statsForVehicle()` from the iter-12 `GET :id/stats`
// route. The aggregation lives in TripsService because the underlying
// data is Trip rows; this module pulls it in rather than duplicating
// the query. The two modules' dependency direction is acyclic:
// TripsModule references the Vehicle table directly through Prisma's
// schema (no TypeScript dependency on this module).
// DocumentsModule is imported for the F3 renewal flow (ADR-0049 c4): the
// renew action validates its optional proof-document link through
// DocumentsService's PUBLIC assertLinkableToVehicle — the module-boundary
// rule (never another module's table). Acyclic: DocumentsModule does not
// import VehiclesModule (it reaches the vehicle table via shared Prisma for
// its own existence check, the ReportsModule precedent).
@Module({
  imports: [AuthModule, TripsModule, DocumentsModule],
  controllers: [VehiclesController, RenewalsController],
  providers: [VehiclesService, RenewalsService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
