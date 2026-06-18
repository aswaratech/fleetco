import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { JobsModule } from "../jobs/jobs.module";
import { TripsModule } from "../trips/trips.module";
import { InvoiceNumberingService } from "./invoice-numbering.service";
import { InvoiceSettingsService } from "./invoice-settings.service";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";

// InvoicesModule — FleetCo's FIRST revenue-side aggregate (Program D / ADR-0039),
// the Invoice + InvoiceLine pair built from the Customer -> Job -> Trip chain.
//
// AuthModule is imported (not just AuthGuard listed in providers) so the AUTH
// provider is available to the guard at request time — see AuthModule's exports
// ([AUTH, AuthGuard]) and ADR-0021 §6. Same pattern Customers / Jobs / Geofences
// follow.
//
// InvoicesService is exported so later tickets that need to read or assemble an
// invoice (D3's issue flow, D4's build-from-trips, D5's PDF render) can reach the
// public service interface without a circular import through the controller.
//
// D1 ships the READ path only (list / detail). Later tickets layer the write
// path, the issue lifecycle, the PDF/R2 storage, and the web surface on top.
//
// D4 (build-from-job/trips) imports JobsModule + TripsModule so InvoicesService can
// read the job (customer-consistency + the line-description fallback) and the trips
// (their dates) through those modules' PUBLIC service interfaces — never their
// tables (ADR-0039 c8 + the CLAUDE.md cross-module rule). No cycle: neither Jobs nor
// Trips depends on Invoices. Both modules export their service (and import AuthModule,
// which provides TripsService's DriverScopeService dependency), so the imports
// resolve cleanly.
@Module({
  imports: [AuthModule, JobsModule, TripsModule],
  controllers: [InvoicesController],
  // InvoiceNumberingService (gapless numbering) and InvoiceSettingsService
  // (FleetCo's supplier-PAN config) are the D3 issue-flow collaborators —
  // providers, not exported: InvoicesService.issue() consumes them internally.
  providers: [InvoicesService, InvoiceNumberingService, InvoiceSettingsService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
