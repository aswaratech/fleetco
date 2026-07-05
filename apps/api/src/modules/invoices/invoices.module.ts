import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { JobsModule } from "../jobs/jobs.module";
import { StorageModule } from "../storage/storage.module";
import { TripsModule } from "../trips/trips.module";
import { InvoiceNumberingService } from "./invoice-numbering.service";
import { InvoicePdfRenderer } from "./invoice-pdf-renderer";
import { InvoiceSettingsService } from "./invoice-settings.service";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { PdfkitInvoiceRenderer } from "./pdfkit.invoice-pdf-renderer";

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
// THE PDF + R2 DI (ADR-0039 c6/c7, D5):
//   • InvoicePdfRenderer → PdfkitInvoiceRenderer always: rendering needs no
//     env/creds (pdfkit is pure-Node), so the renderer is always available (the
//     useFactory mirrors NotificationModule's Mailer wiring).
//   • ObjectStorage now comes from the shared StorageModule (ADR-0044 V2 — the
//     promotion ADR-0039 c7 pre-authorized), which owns the R2-vs-mock factory.
//     issue() still guards on storage.isConfigured() so an unconfigured store
//     refuses issue with a clear 422 rather than silently mocking in prod.
// Tests OVERRIDE these providers with recording stubs to assert render/store.
@Module({
  imports: [AuthModule, JobsModule, TripsModule, StorageModule],
  controllers: [InvoicesController],
  // InvoiceNumberingService (gapless numbering) and InvoiceSettingsService
  // (FleetCo's supplier-PAN config) are the D3 issue-flow collaborators;
  // InvoicePdfRenderer is the D5 render collaborator (ObjectStorage arrives via
  // StorageModule) — all providers, not exported: InvoicesService consumes them
  // internally.
  providers: [
    InvoicesService,
    InvoiceNumberingService,
    InvoiceSettingsService,
    {
      provide: InvoicePdfRenderer,
      useFactory: (): InvoicePdfRenderer => new PdfkitInvoiceRenderer(),
    },
  ],
  exports: [InvoicesService],
})
export class InvoicesModule {}
