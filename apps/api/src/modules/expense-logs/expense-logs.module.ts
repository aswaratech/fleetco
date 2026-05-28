import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ExpenseLogsController } from "./expense-logs.controller";
import { ExpenseLogsService } from "./expense-logs.service";

// ExpenseLogsModule — seventh Phase 1 vertical slice per the roadmap.
// Downstream of Vehicles (iter 1), Trips (iter 8), and Fuel logs (iter
// 19/20): an ExpenseLog optionally references a Vehicle (nullable —
// a vehicle-agnostic expense like the quarterly insurance premium is
// a valid row) and optionally a Trip. Same module shape as
// FuelLogsModule / JobsModule / TripsModule / CustomersModule.
//
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6.
//
// ExpenseLogsService is exported so future modules (e.g., the iter-23
// cost report) can call it without a circular import through the
// controller layer. Every other vertical-slice module exports its
// service for the same reason.
//
// Iter 21 ships read-only — the controller is added in checkpoint 3
// of this same iter. Iter 22 adds the write path (POST/PATCH/DELETE
// endpoints + create/edit/delete UI).
@Module({
  imports: [AuthModule],
  controllers: [ExpenseLogsController],
  providers: [ExpenseLogsService],
  exports: [ExpenseLogsService],
})
export class ExpenseLogsModule {}
