import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { JobsController } from "./jobs.controller";
import { JobsService } from "./jobs.service";

// JobsModule — fifth Phase 1 vertical slice per the roadmap and the
// linking aggregate between Customer (iter 15) and Trip (iter 8):
// Customer 1 → N Job 1 → N Trip (the third dimension lands when iter
// 19 adds Trip.jobId). Customers and Trips exist precisely so this
// aggregate can reference them by id.
//
// AuthModule is imported (not just AuthGuard listed in providers) so
// the AUTH provider is available to the guard at request time — see
// AuthModule's exports ([AUTH, AuthGuard]) and ADR-0021 §6. Same
// shape as TripsModule / CustomersModule.
//
// JobsService is exported so future modules (e.g., a Reports module
// in a later phase, or the Trips module once it grows a jobId FK and
// wants to render the parent job in a trip-detail sidebar) can call
// it without a circular import through the controller layer. Every
// other vertical-slice module exports its service for the same reason.
@Module({
  imports: [AuthModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
