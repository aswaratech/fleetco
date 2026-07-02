import { Module } from "@nestjs/common";

import { CustomersModule } from "../customers/customers.module";
import { DriversModule } from "../drivers/drivers.module";
import { ExpenseLogsModule } from "../expense-logs/expense-logs.module";
import { FuelLogsModule } from "../fuel-logs/fuel-logs.module";
import { GeofencesModule } from "../geofences/geofences.module";
import { JobsModule } from "../jobs/jobs.module";
import { MaintenanceModule } from "../maintenance/maintenance.module";
import { ReportsModule } from "../reports/reports.module";
import { TripsModule } from "../trips/trips.module";
import { VehiclesModule } from "../vehicles/vehicles.module";
import { AgentToolRegistry } from "./tools/tool-registry";

// AgentToolsModule — the AI agent's tool registry (ADR-0043 c1/c3, ticket
// A4). Imports the ten domain modules whose EXPORTED services the tools call
// (the public-interface seam CLAUDE.md sanctions; no module's internals are
// reached) and provides the registry.
//
// DELIBERATELY NOT REGISTERED in app.module.ts yet: A4 ships the registry as
// a tested library; A5 (the agent loop + endpoints + the agent:use gate) has
// AgentModule import this module and wire it into the app graph. Keeping the
// registration out of A4 keeps this branch file-disjoint from the parallel A3
// branch (which owns the app.module.ts edit for AgentModule) — the two merge
// at A5, not in git.
@Module({
  imports: [
    VehiclesModule,
    DriversModule,
    CustomersModule,
    JobsModule,
    TripsModule,
    FuelLogsModule,
    ExpenseLogsModule,
    GeofencesModule,
    MaintenanceModule,
    ReportsModule,
  ],
  providers: [AgentToolRegistry],
  exports: [AgentToolRegistry],
})
export class AgentToolsModule {}
