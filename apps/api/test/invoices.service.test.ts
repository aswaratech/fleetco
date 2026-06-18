import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import {
  CustomerStatus,
  DocumentType,
  InvoiceStatus,
  InvoiceServiceType,
  type Prisma,
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { InvoicesService } from "../src/modules/invoices/invoices.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for InvoicesService against a real Postgres (ADR-0023). D1
// ships the READ path only, so — like the iter-15 Customers / iter-17 Jobs
// read-path tests — rows are seeded via Prisma directly (the create/issue service
// surface lands in D3). Coverage mirrors the read-path precedent plus the two
// things new to this aggregate: the nested detail include (customer + optional
// job + the owned lines) and the FK/provenance round-trips (Invoice -> Customer/
// Job + self-FK credit note; InvoiceLine -> Invoice/Trip/Job).
//
// Invoice.createdById and Invoice.customerId are non-null FKs, so each test seeds
// an admin User + a Customer before it can create an invoice — the same
// self-contained pattern the Customers / Jobs read-path tests use.

describe("InvoicesService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: InvoicesService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [InvoicesService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(InvoicesService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
  });

  async function seedCustomer(overrides: { name?: string; status?: CustomerStatus } = {}) {
    return prisma.customer.create({
      data: {
        name: overrides.name ?? `Acme Construction ${randomUUID().slice(0, 6)}`,
        phone: "+977-9800000000",
        status: overrides.status ?? CustomerStatus.ACTIVE,
        createdById: adminId,
      },
    });
  }

  async function seedJob(customerId: string) {
    return prisma.job.create({
      data: {
        jobNumber: `JOB-2026-${randomUUID().slice(0, 5)}`,
        customerId,
        description: "Haul aggregate from quarry to site",
        createdById: adminId,
      },
    });
  }

  // A full Trip fixture (vehicle + driver + trip) so an invoice line can carry a
  // tripId provenance FK. Trip.vehicleId / driverId / createdById are all
  // required FKs.
  async function seedTrip(): Promise<string> {
    const vehicle = await prisma.vehicle.create({
      data: {
        registrationNumber: `BA-${randomUUID().slice(0, 6)}`,
        kind: "TRUCK",
        make: "Tata",
        model: "LPK 2518",
        year: 2022,
        acquiredAt: new Date("2022-01-01T00:00:00.000Z"),
        createdById: adminId,
      },
    });
    const driver = await prisma.driver.create({
      data: {
        fullName: "Ram Bahadur",
        licenseNumber: `LIC-${randomUUID().slice(0, 6)}`,
        licenseClass: "HTV",
        phone: "+977-9811111111",
        hiredAt: new Date("2022-02-01T00:00:00.000Z"),
        licenseExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
        createdById: adminId,
      },
    });
    const trip = await prisma.trip.create({
      data: {
        vehicleId: vehicle.id,
        driverId: driver.id,
        status: "COMPLETED",
        createdById: adminId,
      },
    });
    return trip.id;
  }

  interface SeedInvoiceInput {
    customerId: string;
    jobId?: string | null;
    status?: InvoiceStatus;
    documentType?: DocumentType;
    number?: string | null;
    originalInvoiceId?: string | null;
    // The frozen-tax snapshot (nullable until issue). Provided only by the
    // detail/issued-shape tests; omitted (null) for plain DRAFT seeds.
    frozen?: {
      subtotalPaisa: number;
      vatRateBp: number;
      vatPaisa: number;
      grossPaisa: number;
      tdsRateBp: number;
      tdsPaisa: number;
      netReceivablePaisa: number;
      serviceType: InvoiceServiceType;
      issuedAt: Date;
    };
  }

  async function seedInvoice(input: SeedInvoiceInput) {
    const data: Prisma.InvoiceUncheckedCreateInput = {
      customerId: input.customerId,
      jobId: input.jobId ?? null,
      status: input.status ?? InvoiceStatus.DRAFT,
      documentType: input.documentType ?? DocumentType.INVOICE,
      number: input.number ?? null,
      originalInvoiceId: input.originalInvoiceId ?? null,
      createdById: adminId,
      ...(input.frozen
        ? {
            subtotalPaisa: input.frozen.subtotalPaisa,
            vatRateBp: input.frozen.vatRateBp,
            vatPaisa: input.frozen.vatPaisa,
            grossPaisa: input.frozen.grossPaisa,
            tdsRateBp: input.frozen.tdsRateBp,
            tdsPaisa: input.frozen.tdsPaisa,
            netReceivablePaisa: input.frozen.netReceivablePaisa,
            serviceType: input.frozen.serviceType,
            issuedAt: input.frozen.issuedAt,
          }
        : {}),
    };
    return prisma.invoice.create({ data });
  }

  describe("findById()", () => {
    test("returns null when not present (controller maps to 404)", async () => {
      const fetched = await service.findById("nonexistent-id");
      expect(fetched).toBeNull();
    });

    test("returns a DRAFT with the nested customer + null job and empty lines (frozen-tax nulls)", async () => {
      const customer = await seedCustomer({ name: "Himalaya Cement Pvt. Ltd." });
      const invoice = await seedInvoice({ customerId: customer.id });

      const fetched = await service.findById(invoice.id);
      expect(fetched?.id).toBe(invoice.id);
      // Nested customer present (FK is NOT NULL).
      expect(fetched?.customer.name).toBe("Himalaya Cement Pvt. Ltd.");
      // Optional job is null on an ad-hoc invoice.
      expect(fetched?.job).toBeNull();
      // No lines yet (the write path lands in D4).
      expect(fetched?.lines).toEqual([]);
      // The frozen-tax snapshot is null until issue (D2/D3) — the load-bearing
      // nullable-until-issue contract.
      expect(fetched?.status).toBe(InvoiceStatus.DRAFT);
      expect(fetched?.documentType).toBe(DocumentType.INVOICE);
      expect(fetched?.number).toBeNull();
      expect(fetched?.subtotalPaisa).toBeNull();
      expect(fetched?.vatRateBp).toBeNull();
      expect(fetched?.vatPaisa).toBeNull();
      expect(fetched?.grossPaisa).toBeNull();
      expect(fetched?.tdsRateBp).toBeNull();
      expect(fetched?.tdsPaisa).toBeNull();
      expect(fetched?.netReceivablePaisa).toBeNull();
      expect(fetched?.serviceType).toBeNull();
      expect(fetched?.issuedAt).toBeNull();
      expect(fetched?.pdfR2Key).toBeNull();
    });

    test("returns the nested job and the owned lines ordered oldest-first", async () => {
      const customer = await seedCustomer();
      const job = await seedJob(customer.id);
      const tripId = await seedTrip();
      const invoice = await seedInvoice({ customerId: customer.id, jobId: job.id });

      // Two lines: one with trip+job provenance, one manual (a flat fee, no FKs).
      // Insert with a small delay so createdAt orders them deterministically and
      // the orderBy [createdAt asc, id asc] is pinned.
      await prisma.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          tripId,
          jobId: job.id,
          description: "Haul aggregate Kalimati -> Pokhara, 2083 Shrawan 3",
          quantity: 3,
          unitPricePaisa: 1_500_000,
          lineAmountPaisa: 4_500_000,
        },
      });
      await new Promise((r) => setTimeout(r, 5));
      await prisma.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          description: "Mobilization fee",
          quantity: 1,
          unitPricePaisa: 500_000,
          lineAmountPaisa: 500_000,
        },
      });

      const fetched = await service.findById(invoice.id);
      expect(fetched?.job?.jobNumber).toBe(job.jobNumber);
      expect(fetched?.lines).toHaveLength(2);
      // Oldest-first ordering.
      expect(fetched?.lines[0]?.description).toBe(
        "Haul aggregate Kalimati -> Pokhara, 2083 Shrawan 3",
      );
      expect(fetched?.lines[1]?.description).toBe("Mobilization fee");
      // Provenance FKs round-trip: the first line carries trip + job, the manual
      // line carries neither.
      expect(fetched?.lines[0]?.tripId).toBe(tripId);
      expect(fetched?.lines[0]?.jobId).toBe(job.id);
      expect(fetched?.lines[0]?.lineAmountPaisa).toBe(4_500_000);
      expect(fetched?.lines[1]?.tripId).toBeNull();
      expect(fetched?.lines[1]?.jobId).toBeNull();
    });

    test("an ISSUED invoice carries the frozen-tax snapshot (the read shape D3 will write)", async () => {
      const customer = await seedCustomer();
      const issued = await seedInvoice({
        customerId: customer.id,
        status: InvoiceStatus.ISSUED,
        number: "INV-2082-83-00001",
        frozen: {
          subtotalPaisa: 5_000_000,
          vatRateBp: 1300,
          vatPaisa: 650_000,
          grossPaisa: 5_650_000,
          tdsRateBp: 150,
          tdsPaisa: 75_000,
          netReceivablePaisa: 5_575_000,
          serviceType: InvoiceServiceType.VEHICLE_HIRE,
          issuedAt: new Date("2026-06-19T00:00:00.000Z"),
        },
      });

      const fetched = await service.findById(issued.id);
      expect(fetched?.status).toBe(InvoiceStatus.ISSUED);
      expect(fetched?.number).toBe("INV-2082-83-00001");
      expect(fetched?.subtotalPaisa).toBe(5_000_000);
      expect(fetched?.vatRateBp).toBe(1300);
      expect(fetched?.grossPaisa).toBe(5_650_000);
      expect(fetched?.tdsRateBp).toBe(150);
      expect(fetched?.netReceivablePaisa).toBe(5_575_000);
      expect(fetched?.serviceType).toBe(InvoiceServiceType.VEHICLE_HIRE);
    });

    test("a CREDIT_NOTE references its original invoice via the self-FK (round-trips)", async () => {
      const customer = await seedCustomer();
      const original = await seedInvoice({
        customerId: customer.id,
        status: InvoiceStatus.ISSUED,
        number: "INV-2082-83-00002",
      });
      const creditNote = await seedInvoice({
        customerId: customer.id,
        documentType: DocumentType.CREDIT_NOTE,
        originalInvoiceId: original.id,
      });

      const fetched = await service.findById(creditNote.id);
      expect(fetched?.documentType).toBe(DocumentType.CREDIT_NOTE);
      expect(fetched?.originalInvoiceId).toBe(original.id);
    });
  });

  describe("list() — filter / sort / paginate", () => {
    // Seed five invoices across two customers with known shapes so the
    // assertions below can be precise. customerC's invoices are ISSUED; the rest
    // are DRAFT.
    interface ListSeed {
      customerKey: "A" | "B";
      status?: InvoiceStatus;
      documentType?: DocumentType;
      number?: string | null;
    }

    async function seedFive(): Promise<{ customerA: string; customerB: string }> {
      const customerA = await seedCustomer({ name: "Customer A" });
      const customerB = await seedCustomer({ name: "Customer B" });
      const map = { A: customerA.id, B: customerB.id };
      const seeds: ListSeed[] = [
        { customerKey: "A", status: InvoiceStatus.DRAFT },
        { customerKey: "A", status: InvoiceStatus.ISSUED, number: "INV-2082-83-00010" },
        {
          customerKey: "A",
          status: InvoiceStatus.ISSUED,
          documentType: DocumentType.CREDIT_NOTE,
          number: "CRN-2082-83-00001",
        },
        { customerKey: "B", status: InvoiceStatus.DRAFT },
        { customerKey: "B", status: InvoiceStatus.CANCELLED },
      ];
      for (const seed of seeds) {
        await seedInvoice({
          customerId: map[seed.customerKey],
          status: seed.status,
          documentType: seed.documentType,
          number: seed.number,
        });
      }
      return { customerA: customerA.id, customerB: customerB.id };
    }

    test("no filters → returns all rows with correct total", async () => {
      await seedFive();
      const result = await service.list({});
      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(5);
      // The slim projection includes the nested customer name.
      expect(result.items[0]?.customer.name).toBeTruthy();
    });

    test("status filter narrows results (ISSUED)", async () => {
      await seedFive();
      const result = await service.list({ status: [InvoiceStatus.ISSUED] });
      expect(result.total).toBe(2);
      expect(result.items.every((i) => i.status === InvoiceStatus.ISSUED)).toBe(true);
    });

    test("multi-status filter is OR within the dimension", async () => {
      await seedFive();
      const result = await service.list({
        status: [InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED],
      });
      expect(result.total).toBe(3);
    });

    test("documentType filter narrows to credit notes", async () => {
      await seedFive();
      const result = await service.list({ documentType: [DocumentType.CREDIT_NOTE] });
      expect(result.total).toBe(1);
      expect(result.items[0]?.documentType).toBe(DocumentType.CREDIT_NOTE);
    });

    test("customerId filter narrows to one customer's invoices", async () => {
      const { customerA } = await seedFive();
      const result = await service.list({ customerId: customerA });
      expect(result.total).toBe(3);
      expect(result.items.every((i) => i.customerId === customerA)).toBe(true);
    });

    test("filters compose (AND): customerId + status", async () => {
      const { customerA } = await seedFive();
      const result = await service.list({
        customerId: customerA,
        status: [InvoiceStatus.ISSUED],
      });
      expect(result.total).toBe(2);
      expect(result.items.every((i) => i.customerId === customerA)).toBe(true);
      expect(result.items.every((i) => i.status === InvoiceStatus.ISSUED)).toBe(true);
    });

    test("empty-array status is treated as no filter (defense-in-depth)", async () => {
      await seedFive();
      const result = await service.list({ status: [] });
      expect(result.total).toBe(5);
    });

    test("default sort is createdAt desc (newest first)", async () => {
      const customer = await seedCustomer();
      const first = await seedInvoice({ customerId: customer.id });
      await new Promise((r) => setTimeout(r, 5));
      const second = await seedInvoice({ customerId: customer.id });
      await new Promise((r) => setTimeout(r, 5));
      const third = await seedInvoice({ customerId: customer.id });

      const result = await service.list({});
      expect(result.items.map((i) => i.id)).toEqual([third.id, second.id, first.id]);
    });

    test("sortBy=number asc returns numbered rows in order, with null-number DRAFTs last", async () => {
      const customer = await seedCustomer();
      // Two numbered (ISSUED) + one unnumbered (DRAFT). Postgres sorts NULLs last
      // in asc, so the DRAFT trails the two numbered rows.
      await seedInvoice({ customerId: customer.id, status: InvoiceStatus.DRAFT, number: null });
      await seedInvoice({
        customerId: customer.id,
        status: InvoiceStatus.ISSUED,
        number: "INV-2082-83-00002",
      });
      await seedInvoice({
        customerId: customer.id,
        status: InvoiceStatus.ISSUED,
        number: "INV-2082-83-00001",
      });

      const result = await service.list({ sortBy: "number", sortDir: "asc" });
      const numbers = result.items.map((i) => i.number);
      expect(numbers).toEqual(["INV-2082-83-00001", "INV-2082-83-00002", null]);
    });

    test("pagination: skip + take returns the right window; total reflects the full match", async () => {
      const customer = await seedCustomer();
      for (let n = 1; n <= 5; n += 1) {
        await seedInvoice({
          customerId: customer.id,
          status: InvoiceStatus.ISSUED,
          number: `INV-2082-83-0000${n}`,
        });
      }
      const page = await service.list({ sortBy: "number", sortDir: "asc", skip: 2, take: 2 });
      const numbers = page.items.map((i) => i.number);
      expect(numbers).toEqual(["INV-2082-83-00003", "INV-2082-83-00004"]);
      expect(page.total).toBe(5);
    });

    test("take is clamped at LIST_TAKE_MAX (defense-in-depth from the controller schema)", async () => {
      await seedFive();
      const result = await service.list({ take: 10_000 });
      expect(result.items.length).toBeLessThanOrEqual(5);
      expect(result.total).toBe(5);
    });

    test("skip beyond the result set returns an empty page with the correct total", async () => {
      await seedFive();
      const page = await service.list({ skip: 100, take: 10 });
      expect(page.items).toHaveLength(0);
      expect(page.total).toBe(5);
    });
  });

  // The FK delete policy is a core D1 deliverable (ADR-0039 c1): the house
  // Restrict posture everywhere except the one true parent-child edge
  // (Invoice -> InvoiceLine Cascade). These tests assert the policy at the DB
  // level via raw Prisma so a future migration that weakens an FK (cascade where
  // it should restrict, or vice-versa) fails loudly here. P2003 is the FK-
  // constraint-violation code CustomersService.delete already maps to HTTP 409.
  describe("FK delete policy (ADR-0039 c1)", () => {
    test("a customer referenced by an invoice cannot be deleted (Restrict raises P2003)", async () => {
      const customer = await seedCustomer();
      await seedInvoice({ customerId: customer.id });

      let code: string | undefined;
      try {
        await prisma.customer.delete({ where: { id: customer.id } });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      // The same P2003 CustomersService.delete maps to a clean 409 via its
      // EXISTING arm (no CustomersService change in Program D). The row survives.
      expect(code).toBe("P2003");
      const survived = await prisma.customer.findUnique({ where: { id: customer.id } });
      expect(survived).not.toBeNull();
    });

    test("deleting an invoice cascades to its owned lines (Cascade)", async () => {
      const customer = await seedCustomer();
      const invoice = await seedInvoice({ customerId: customer.id });
      await prisma.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          description: "Mobilization fee",
          quantity: 1,
          unitPricePaisa: 500_000,
          lineAmountPaisa: 500_000,
        },
      });

      await prisma.invoice.delete({ where: { id: invoice.id } });
      const remaining = await prisma.invoiceLine.count({ where: { invoiceId: invoice.id } });
      expect(remaining).toBe(0);
    });

    test("a trip referenced by an invoice line cannot be deleted (Restrict raises P2003)", async () => {
      const customer = await seedCustomer();
      const invoice = await seedInvoice({ customerId: customer.id });
      const tripId = await seedTrip();
      await prisma.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          tripId,
          description: "Haul aggregate",
          quantity: 1,
          unitPricePaisa: 100,
          lineAmountPaisa: 100,
        },
      });

      let code: string | undefined;
      try {
        await prisma.trip.delete({ where: { id: tripId } });
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("P2003");
    });
  });
});
