import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DocumentType, InvoiceServiceType, InvoiceStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { InvoiceNumberingService } from "../src/modules/invoices/invoice-numbering.service";
import { InvoicePdfRenderer } from "../src/modules/invoices/invoice-pdf-renderer";
import { InvoiceSettingsService } from "../src/modules/invoices/invoice-settings.service";
import { computeInvoiceTax } from "../src/modules/invoices/invoice-tax";
import { InvoicesController } from "../src/modules/invoices/invoices.controller";
import { InvoicesService } from "../src/modules/invoices/invoices.service";
import { MockObjectStorage } from "../src/modules/invoices/mock.object-storage";
import { ObjectStorage } from "../src/modules/invoices/object-storage";
import { PdfkitInvoiceRenderer } from "../src/modules/invoices/pdfkit.invoice-pdf-renderer";
import { JobsService } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsService } from "../src/modules/trips/trips.service";
import { resetDb } from "./db";

// The D3 issue lifecycle + credit-note seam (ADR-0039 c4–5) against real
// Postgres. issue() lives in its own file because it needs the numbering +
// settings collaborators wired (and a supplier-PAN stub the other test files
// don't). Both the service layer (the business logic) and the controller layer
// (route wiring + session-id) are covered here, under one PAN-configured module.
//
// The supplier PAN is a per-test mutable: a TEST value by default (clearly not a
// real PAN), flipped to null in the one "not configured" test. The stub reads it
// at call time, so reassigning it between tests takes effect.
//
// Fiscal-year dates verified against nepali-date-converter@3.4.0:
//   2025-08-01 → BS 2082 Shrawan → FY 2082-83
//   2026-08-01 → BS 2083 Shrawan → FY 2083-84
const FY_2082_83 = new Date("2025-08-01T00:00:00.000Z");
const FY_2083_84 = new Date("2026-08-01T00:00:00.000Z");

describe("Invoice issue + credit-note (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: InvoicesService;
  let controller: InvoicesController;
  let adminId: string;
  let supplierPan: string | null;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        InvoicesService,
        InvoiceNumberingService,
        PrismaService,
        // D4: InvoicesService now reads jobs/trips through these public interfaces
        // (TripsService needs DriverScopeService). The issue tests seed lines via
        // Prisma directly, but the constructor deps must still resolve.
        JobsService,
        TripsService,
        DriverScopeService,
        // The supplier-PAN config is stubbed so the issue precondition is
        // controllable (a TEST PAN by default; null in the "not configured" test);
        // getSupplierName feeds the D5 render model (a safe default name).
        {
          provide: InvoiceSettingsService,
          useValue: { getSupplierPan: () => supplierPan, getSupplierName: () => "FleetCo" },
        },
        // D5: issue() now renders + stores the frozen PDF. A real renderer + an
        // in-memory mock store (configured by default) so the existing issue
        // assertions still hold and pdfR2Key is set; the dedicated render/store
        // assertions live in invoices.pdf.test.ts.
        { provide: InvoicePdfRenderer, useValue: new PdfkitInvoiceRenderer() },
        { provide: ObjectStorage, useValue: new MockObjectStorage() },
        // AUTH satisfies AuthGuard's constructor; the guard is overridden below.
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(InvoicesService);
    controller = module.get(InvoicesController);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    supplierPan = "TEST-SUPPLIER-PAN"; // configured by default; one test sets null
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: { id: adminId, email: `admin-${adminId}@fleetco.test`, name: "Test Admin" },
    });
  });

  async function seedCustomer(): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        name: `Acme ${randomUUID().slice(0, 6)}`,
        phone: "+977-9800000000",
        createdById: adminId,
      },
    });
    return customer.id;
  }

  // A DRAFT invoice with the given line amounts + serviceType (defaults to
  // VEHICLE_HIRE). Lines are seeded directly via Prisma — D4 supplies the line
  // API; D3 only needs them present to issue.
  async function seedDraftWithLines(opts: {
    lineAmounts: number[];
    serviceType?: InvoiceServiceType | null;
    discountPaisa?: number | null;
    documentType?: DocumentType;
  }): Promise<string> {
    const customerId = await seedCustomer();
    const invoice = await prisma.invoice.create({
      data: {
        customerId,
        createdById: adminId,
        documentType: opts.documentType ?? DocumentType.INVOICE,
        serviceType:
          opts.serviceType === undefined ? InvoiceServiceType.VEHICLE_HIRE : opts.serviceType,
        discountPaisa: opts.discountPaisa ?? null,
      },
    });
    for (const amount of opts.lineAmounts) {
      await prisma.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          description: "Haul aggregate",
          quantity: 1,
          unitPricePaisa: amount,
          lineAmountPaisa: amount,
        },
      });
    }
    return invoice.id;
  }

  function requestAs(userId: string): AuthenticatedRequest {
    return { session: { user: { id: userId } } } as unknown as AuthenticatedRequest;
  }

  describe("issue() — freeze + number + lifecycle", () => {
    test("freezes the tax snapshot, assigns the gapless number, and flips to ISSUED", async () => {
      // The D2 worked example: lines [1_000_000, 235_050], VEHICLE_HIRE, no discount.
      const id = await seedDraftWithLines({
        lineAmounts: [1_000_000, 235_050],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      const issued = await service.issue(id, FY_2082_83);

      expect(issued.status).toBe(InvoiceStatus.ISSUED);
      expect(issued.number).toBe("INV-2082-83-00001");
      expect(issued.issuedAt).not.toBeNull();
      // Every frozen figure matches D2's worked half-up example exactly.
      expect(issued.subtotalPaisa).toBe(1_235_050);
      expect(issued.discountPaisa).toBe(0);
      expect(issued.vatRateBp).toBe(1300);
      expect(issued.vatPaisa).toBe(160_557);
      expect(issued.grossPaisa).toBe(1_395_607);
      expect(issued.tdsRateBp).toBe(150);
      expect(issued.tdsPaisa).toBe(18_526);
      expect(issued.netReceivablePaisa).toBe(1_377_081);
      expect(issued.serviceType).toBe(InvoiceServiceType.VEHICLE_HIRE);
    });

    test("the frozen figures equal computeInvoiceTax (rates ride in the snapshot)", async () => {
      const id = await seedDraftWithLines({
        lineAmounts: [500_000, 500_000],
        serviceType: InvoiceServiceType.GOODS_TRANSPORT,
        discountPaisa: 100_000,
      });
      const issued = await service.issue(id, FY_2082_83);
      const expected = computeInvoiceTax({
        lineAmountsPaisa: [500_000, 500_000],
        discountPaisa: 100_000,
        serviceType: InvoiceServiceType.GOODS_TRANSPORT,
      });

      expect(issued.subtotalPaisa).toBe(expected.subtotalPaisa);
      expect(issued.discountPaisa).toBe(expected.discountPaisa);
      expect(issued.vatPaisa).toBe(expected.vatPaisa);
      expect(issued.grossPaisa).toBe(expected.grossPaisa);
      expect(issued.tdsRateBp).toBe(250); // GOODS_TRANSPORT rate (vs 150 vehicle-hire)
      expect(issued.tdsPaisa).toBe(expected.tdsPaisa);
      expect(issued.netReceivablePaisa).toBe(expected.netReceivablePaisa);
    });

    test("the snapshot is a stored historical fact — a later line change does NOT recompute it", async () => {
      const id = await seedDraftWithLines({
        lineAmounts: [1_000_000],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      const issued = await service.issue(id, FY_2082_83);
      expect(issued.subtotalPaisa).toBe(1_000_000);

      // Simulate a line mutation the API forbids (an issued invoice is immutable)
      // to prove the frozen figure is STORED, not recomputed at read time.
      await prisma.invoiceLine.create({
        data: {
          invoiceId: id,
          description: "Sneaky after-issue line",
          quantity: 1,
          unitPricePaisa: 9_999_999,
          lineAmountPaisa: 9_999_999,
        },
      });
      const refetched = await service.findById(id);
      expect(refetched?.subtotalPaisa).toBe(1_000_000); // unchanged — frozen at issue
    });

    test("an already-ISSUED invoice cannot be re-issued (409) and no number is burned", async () => {
      const id = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      await service.issue(id, FY_2082_83); // → INV-2082-83-00001
      await expect(service.issue(id, FY_2082_83)).rejects.toThrow(ConflictException);

      // The counter advanced exactly once — the rejected re-issue never reached it.
      const counter = await prisma.invoiceNumberSequence.findUnique({
        where: { documentType_bsFiscalYear: { documentType: "INVOICE", bsFiscalYear: "2082-83" } },
      });
      expect(counter?.lastValue).toBe(1);
    });

    test("issuing with no lines → 422 (and the draft is untouched)", async () => {
      const customerId = await seedCustomer();
      const draft = await prisma.invoice.create({
        data: { customerId, createdById: adminId, serviceType: InvoiceServiceType.VEHICLE_HIRE },
      });
      await expect(service.issue(draft.id, FY_2082_83)).rejects.toThrow(
        UnprocessableEntityException,
      );
      const after = await service.findByIdRaw(draft.id);
      expect(after?.status).toBe(InvoiceStatus.DRAFT);
      expect(after?.number).toBeNull();
    });

    test("issuing with no serviceType → 422 (it selects the TDS rate)", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [100], serviceType: null });
      await expect(service.issue(id, FY_2082_83)).rejects.toThrow(UnprocessableEntityException);
    });

    test("issuing with the supplier PAN not configured → 422 (a documented precondition)", async () => {
      supplierPan = null; // operator has not filled it in
      const id = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      await expect(service.issue(id, FY_2082_83)).rejects.toThrow(UnprocessableEntityException);
      // The draft is untouched, and no counter row was created.
      const after = await service.findByIdRaw(id);
      expect(after?.status).toBe(InvoiceStatus.DRAFT);
      expect(await prisma.invoiceNumberSequence.count()).toBe(0);
    });

    test("issuing with a discount exceeding the subtotal → 422 (computeInvoiceTax RangeError mapped)", async () => {
      const id = await seedDraftWithLines({
        lineAmounts: [100_000],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
        discountPaisa: 200_000,
      });
      await expect(service.issue(id, FY_2082_83)).rejects.toThrow(UnprocessableEntityException);
      // No number burned — the failure rolled back before/at the counter.
      const after = await service.findByIdRaw(id);
      expect(after?.status).toBe(InvoiceStatus.DRAFT);
      expect(await prisma.invoiceNumberSequence.count()).toBe(0);
    });

    test("two different invoices issued concurrently get consecutive gapless numbers", async () => {
      const idA = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      const idB = await seedDraftWithLines({
        lineAmounts: [200],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      const [a, b] = await Promise.all([
        service.issue(idA, FY_2082_83),
        service.issue(idB, FY_2082_83),
      ]);
      expect([a.number, b.number].sort()).toEqual(["INV-2082-83-00001", "INV-2082-83-00002"]);
    });

    test("the number is keyed by the issue date's BS fiscal year", async () => {
      const id1 = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      const id2 = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      expect((await service.issue(id1, FY_2082_83)).number).toBe("INV-2082-83-00001");
      // A different fiscal year → a fresh …-00001.
      expect((await service.issue(id2, FY_2083_84)).number).toBe("INV-2083-84-00001");
    });

    test("an ISSUED invoice is immutable: a later update is refused (409)", async () => {
      const id = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      await service.issue(id, FY_2082_83);
      await expect(service.update(id, { discountPaisa: 0 })).rejects.toThrow(ConflictException);
    });
  });

  describe("end-to-end write path (create → addLine → set serviceType → issue)", () => {
    // Every other issue test seeds the draft + its lines directly via Prisma; this
    // one walks the REAL manual operator write path end to end — create() the DRAFT
    // header, add lines through addLine() (which derives lineAmountPaisa
    // server-side), set the serviceType via update(), then issue() against the
    // configured supplier PAN + the (mock) R2 store — and asserts the ISSUED row
    // carries the gapless number, the frozen snapshot built FROM the derived line
    // amounts, AND the pdfR2Key. It is the only test that proves the whole manual
    // write path composes through the service's own methods (ADR-0039 c2/c4/c5/c7).
    test("a manually-built draft issues with the gapless number, frozen snapshot, and stored PDF key", async () => {
      const customerId = await seedCustomer();

      // 1. create() the DRAFT header — no number, no serviceType, no frozen totals.
      const draft = await service.create({ customerId }, adminId);
      expect(draft.status).toBe(InvoiceStatus.DRAFT);
      expect(draft.documentType).toBe(DocumentType.INVOICE);
      expect(draft.number).toBeNull();
      expect(draft.lines).toHaveLength(0);

      // 2. addLine() twice — the amounts are the D2 worked example so the frozen
      //    snapshot below is the known one, now arrived-at through the real write path.
      await service.addLine(draft.id, {
        description: "Haul aggregate Kalimati to Pokhara",
        quantity: 1,
        unitPricePaisa: 1_000_000,
      });
      await service.addLine(draft.id, {
        description: "Mobilization fee",
        quantity: 1,
        unitPricePaisa: 235_050,
      });

      // 3. set the serviceType via update() (it selects the TDS rate at issue).
      const ready = await service.update(draft.id, {
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      expect(ready?.serviceType).toBe(InvoiceServiceType.VEHICLE_HIRE);

      // 4. issue() — PAN + (mock) R2 are configured by the harness.
      const issued = await service.issue(draft.id, FY_2082_83);

      expect(issued.status).toBe(InvoiceStatus.ISSUED);
      expect(issued.number).toBe("INV-2082-83-00001");
      expect(issued.issuedAt).not.toBeNull();
      // The frozen snapshot — built from the addLine-derived line amounts.
      expect(issued.subtotalPaisa).toBe(1_235_050);
      expect(issued.vatRateBp).toBe(1300);
      expect(issued.vatPaisa).toBe(160_557);
      expect(issued.grossPaisa).toBe(1_395_607);
      expect(issued.tdsRateBp).toBe(150);
      expect(issued.netReceivablePaisa).toBe(1_377_081);
      // The PDF was rendered + stored at issue; the key is recorded on the row.
      expect(issued.pdfR2Key).toBe(`invoices/${issued.id}.pdf`);
    });
  });

  describe("createCreditNote() — the correction seam + independent series", () => {
    test("creates a CREDIT_NOTE draft referencing the original and copying its lines", async () => {
      const origId = await seedDraftWithLines({
        lineAmounts: [1_000_000],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      await service.issue(origId, FY_2082_83);

      const cn = await service.createCreditNote(origId, adminId);
      expect(cn.documentType).toBe(DocumentType.CREDIT_NOTE);
      expect(cn.originalInvoiceId).toBe(origId);
      expect(cn.status).toBe(InvoiceStatus.DRAFT);
      expect(cn.number).toBeNull(); // unnumbered until issued
      expect(cn.serviceType).toBe(InvoiceServiceType.VEHICLE_HIRE);
      expect(cn.lines).toHaveLength(1); // copied from the original
      expect(cn.lines[0]?.lineAmountPaisa).toBe(1_000_000);
      expect(cn.createdById).toBe(adminId);
    });

    test("an issued credit note draws from its OWN gapless series (independent of invoices)", async () => {
      const origId = await seedDraftWithLines({
        lineAmounts: [1_000_000],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      const issuedOrig = await service.issue(origId, FY_2082_83);
      expect(issuedOrig.number).toBe("INV-2082-83-00001");

      const cn = await service.createCreditNote(origId, adminId);
      const issuedCn = await service.issue(cn.id, FY_2082_83);
      expect(issuedCn.number).toBe("CRN-2082-83-00001"); // the credit-note series

      // The INVOICE series is unaffected — the next invoice is …-00002.
      const id2 = await seedDraftWithLines({
        lineAmounts: [500],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      expect((await service.issue(id2, FY_2082_83)).number).toBe("INV-2082-83-00002");
    });

    test("only an ISSUED INVOICE can be credited (a DRAFT original → 409)", async () => {
      const draftId = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      await expect(service.createCreditNote(draftId, adminId)).rejects.toThrow(ConflictException);
    });

    test("a credit note cannot itself be credited (non-INVOICE original → 409)", async () => {
      const origId = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      await service.issue(origId, FY_2082_83);
      const cn = await service.createCreditNote(origId, adminId);
      await service.issue(cn.id, FY_2082_83);
      await expect(service.createCreditNote(cn.id, adminId)).rejects.toThrow(ConflictException);
    });

    test("a missing original → 404", async () => {
      await expect(service.createCreditNote("nonexistent-id", adminId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("controller wiring (issue + credit-notes)", () => {
    test("POST /:id/issue flips a draft to ISSUED through the controller", async () => {
      const id = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      const issued = await controller.issue(id);
      expect(issued.status).toBe(InvoiceStatus.ISSUED);
      expect(issued.number).toMatch(/^INV-\d{4}-\d{2}-\d{5}$/);
    });

    test("POST /:id/credit-notes creates a credit note with createdById from the session", async () => {
      const origId = await seedDraftWithLines({
        lineAmounts: [100],
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });
      await controller.issue(origId);
      const cn = await controller.createCreditNote(origId, requestAs(adminId));
      expect(cn.documentType).toBe(DocumentType.CREDIT_NOTE);
      expect(cn.originalInvoiceId).toBe(origId);
      expect(cn.createdById).toBe(adminId);
    });
  });
});
