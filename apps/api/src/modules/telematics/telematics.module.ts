import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { GpsIngestProcessor } from "./gps-ingest.processor";
import { TelematicsController } from "./telematics.controller";
import { GPS_INGEST_QUEUE, TelematicsService } from "./telematics.service";

// TelematicsModule — the first Phase-2 telematics feature slice (ADR-0029 T3).
// It OWNS the `gps-ingest` queue per ADR-0029 commitment 2's per-feature queue
// ownership: the root BullMQ config (shared connection + default job options)
// lives in the @Global() QueueModule from T1, but the concrete queue is
// registered HERE via BullModule.registerQueue, so the queue's producer
// (TelematicsService), its worker (GpsIngestProcessor), and the feature they
// serve live together (the ADR-0001 modular-monolith rule). The queue is NOT
// registered globally.
//
// AuthModule is imported (not just the guards listed in providers) so the AUTH
// provider, AuthGuard, and RolesGuard are available to the controller's
// composed `@UseGuards(AuthGuard, RolesGuard)` chain at request time — see
// AuthModule's exports and ADR-0021 §6 / ADR-0028 c5.
//
// TelematicsService is exported so a future telematics read slice (T5) can
// reuse it without a circular import through the controller layer, the same
// convention every vertical-slice module follows.
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: GPS_INGEST_QUEUE })],
  controllers: [TelematicsController],
  providers: [TelematicsService, GpsIngestProcessor],
  exports: [TelematicsService],
})
export class TelematicsModule {}
