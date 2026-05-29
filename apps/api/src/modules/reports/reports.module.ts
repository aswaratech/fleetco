import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";

import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

// ReportsModule — the eighth and final Phase-1 vertical slice per the
// roadmap. Read-only aggregation surface over Fuel logs (iter 19/20)
// and Expense logs (iter 21/22); owns no model, no migration, and no
// write surface. Same module shape as every other vertical-slice
// module (ExpenseLogsModule / FuelLogsModule / etc), minus a
// providers'-side service-export — no downstream module imports
// ReportsService today.
//
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6. Every
// route on ReportsController is auth-guarded at the controller level.
//
// ReportsService is exported on principle (a future Phase-2 slice
// might want to call it from a scheduled-report job or an email-
// digest service); the same convention every other vertical-slice
// module follows. No call sites today.
@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
