import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { GeofencesModule } from "../geofences/geofences.module";
import { GpsIngestProcessor } from "./gps-ingest.processor";
import { IngestKeyGuard, ingestApiKeyProvider } from "./ingest-key.guard";
import { TelematicsController } from "./telematics.controller";
import { GPS_INGEST_QUEUE, TelematicsService } from "./telematics.service";
import { TraccarIngestController } from "./traccar-ingest.controller";
import { TraccarIngestService } from "./traccar-ingest.service";

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
//
// GeofencesModule is imported (ADR-0030 G5) so the TelematicsService can
// resolve its exported GeofencesService and load a STORED fence by id in the
// geofence-status query (the geofenceId branch). GeofencesModule does not
// import TelematicsModule, so there is no circular dependency; the geofence
// aggregate is reached through its public service interface, not its table.
// The M5 Traccar gateway adapter (ADR-0042) rides in this module too: a
// second, MACHINE-authenticated controller (TraccarIngestController behind
// IngestKeyGuard alone — no session chain) feeding the SAME gps-ingest queue
// through TraccarIngestService. ingestApiKeyProvider binds the Tier-1
// INGEST_API_KEY from the typed env, so tests exercise the guard's
// configured/unconfigured branches by overriding one provider.
@Module({
  imports: [AuthModule, GeofencesModule, BullModule.registerQueue({ name: GPS_INGEST_QUEUE })],
  controllers: [TelematicsController, TraccarIngestController],
  providers: [
    TelematicsService,
    GpsIngestProcessor,
    TraccarIngestService,
    IngestKeyGuard,
    ingestApiKeyProvider,
  ],
  exports: [TelematicsService],
})
export class TelematicsModule {}
