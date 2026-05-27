import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { CustomersController } from "./customers.controller";
import { CustomersService } from "./customers.service";

// CustomersModule — third Phase 1 vertical slice per the roadmap.
// Owns the Customer aggregate (a party who hires FleetCo's vehicles
// for jobs — see docs/glossary.md). Customer is master data; it does
// NOT FK into Trip directly. The future Jobs aggregate will reference
// Customer, and Trips will belong to Jobs.
//
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6. Same
// pattern Vehicles, Drivers, and Trips follow.
//
// CustomersService is exported so the future Jobs module (and any
// other module that needs a customer lookup) can findById customers
// without a circular import through the controller layer.
//
// Iter 15 ships the read path only (list / detail). Iter 16 layers
// the write path on top; no module changes are expected for that —
// the existing controller picks up the additional Post/Patch/Delete
// routes and the service grows create/update/delete methods.
@Module({
  imports: [AuthModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
