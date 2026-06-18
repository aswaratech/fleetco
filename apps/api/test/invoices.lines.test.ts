import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { InvoiceServiceType, InvoiceStatus } from "@prisma/client";
import { formatNepaliDate } from "@fleetco/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { InvoiceNumberingService } from "../src/modules/invoices/invoice-numbering.service";
import { InvoiceSettingsService } from "../src/modules/invoices/invoice-settings.service";
import { InvoicesController } from "../src/modules/invoices/invoices.controller";
import { InvoicesService } from "../src/modules/invoices/invoices.service";
import {
  BuildFromJobSchema,
  CreateInvoiceLineSchema,
  UpdateInvoiceLineSchema,
} from "../src/modules/invoices/invoices.schemas";
import { JobsService } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsService } from "../src/modules/trips/trips.service";
import { resetDb } from "./db";

// D4 — invoice LINE management + build-from-job (ADR-0039 c2, c8). The lines are
// the first place a SELLING amount is captured (the Trip has no price), so this
// slice supplies what D3's issue() already sums + freezes (subtotalPaisa = Σ
// lineAmountPaisa). Tested against real Postgres, mirroring invoices.issue.test.ts
// (the PAN-stubbed harness, so build -> issue works end-to-end here).
//
// THE D4 ARCHITECTURAL REALITY under test: there is NO Trip->Job link in the schema
// (Trip has no jobId — it was never built), so build-from-job is NOT a Job->Trip
// traversal; the operator supplies which trips to bill + the per-trip amounts, and
// the job is provenance + the description fallback. The strongest consistency rule
// the schema supports — a referenced JOB belongs to the invoice's CUSTOMER — IS
// enforced; the trip-level customer check is impossible (flagged, not guessed).

// A date with a known, in-range BS conversion (the D3 fiscal-year fixtures): BS
// 2082 Shrawan. The description assertions recompute the BS string via the shared
// formatNepaliDate so they pin the integration, not a hard-coded BS value.
const TRIP_DATE_A = new Date("2025-08-01T00:00:00.000Z");
const TRIP_DATE_B = new Date("2025-08-15T00:00:00.000Z");
const FY_2082_83 = new Date("2025-08-01T00:00:00.000Z");
const JOB_DESCRIPTION = "Haul aggregate Kalimati to Pokhara";

describe("Invoice lines + build-from-job (integration, real Postgres)", () => {
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
        JobsService,
        TripsService,
        DriverScopeService,
        PrismaService,
        // Stubbed so build -> issue can run (the issue precondition needs a PAN).
        { provide: InvoiceSettingsService, useValue: { getSupplierPan: () => supplierPan } },
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
    supplierPan = "TEST-SUPPLIER-PAN";
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

  async function seedJob(customerId: string): Promise<string> {
    const job = await prisma.job.create({
      data: {
        jobNumber: `JOB-2026-${randomUUID().slice(0, 5)}`,
        customerId,
        description: JOB_DESCRIPTION,
        createdById: adminId,
      },
    });
    return job.id;
  }

  // A full Trip fixture (vehicle + driver + trip). startedAt drives the BS date the
  // build-from-job line description carries.
  async function seedTrip(startedAt: Date | null = TRIP_DATE_A): Promise<string> {
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
        startedAt,
        createdById: adminId,
      },
    });
    return trip.id;
  }

  async function seedDraft(
    customerId: string,
    opts: { jobId?: string; serviceType?: InvoiceServiceType } = {},
  ): Promise<string> {
    const invoice = await prisma.invoice.create({
      data: {
        customerId,
        jobId: opts.jobId ?? null,
        serviceType: opts.serviceType ?? InvoiceServiceType.VEHICLE_HIRE,
        createdById: adminId,
      },
    });
    return invoice.id;
  }

  // -------------------------------------------------------------------------
  // Pipe layer — the .strict() schemas reject a client-set lineAmountPaisa.
  // -------------------------------------------------------------------------
  describe("line schemas (pipe layer)", () => {
    const createPipe = new ZodValidationPipe(CreateInvoiceLineSchema);
    const updatePipe = new ZodValidationPipe(UpdateInvoiceLineSchema);
    const buildPipe = new ZodValidationPipe(BuildFromJobSchema);

    test("CreateInvoiceLineSchema rejects a client-set lineAmountPaisa (derived only)", () => {
      expect(() =>
        createPipe.transform({
          description: "x",
          quantity: 1,
          unitPricePaisa: 100,
          lineAmountPaisa: 999,
        }),
      ).toThrow(BadRequestException);
    });

    test("CreateInvoiceLineSchema accepts a manual line (no tripId/jobId)", () => {
      const parsed = createPipe.transform({
        description: "Mobilization fee",
        quantity: 1,
        unitPricePaisa: 2_000_000,
      });
      expect(parsed.tripId).toBeUndefined();
      expect(parsed.jobId).toBeUndefined();
    });

    test("CreateInvoiceLineSchema rejects quantity < 1", () => {
      expect(() =>
        createPipe.transform({ description: "x", quantity: 0, unitPricePaisa: 100 }),
      ).toThrow(BadRequestException);
    });

    test("UpdateInvoiceLineSchema rejects an empty patch (no fields)", () => {
      expect(() => updatePipe.transform({})).toThrow(BadRequestException);
    });

    test("BuildFromJobSchema rejects an empty lines array", () => {
      expect(() => buildPipe.transform({ jobId: "job_1", lines: [] })).toThrow(BadRequestException);
    });

    test("BuildFromJobSchema accepts trip lines with optional per-line description", () => {
      const parsed = buildPipe.transform({
        jobId: "job_1",
        lines: [{ tripId: "trip_1", quantity: 2, unitPricePaisa: 500 }],
      });
      expect(parsed.lines).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // addLine
  // -------------------------------------------------------------------------
  describe("addLine()", () => {
    test("adds a MANUAL line (no tripId/jobId) and derives lineAmountPaisa", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      const detail = await service.addLine(id, {
        description: "Mobilization fee",
        quantity: 1,
        unitPricePaisa: 2_000_000,
      });
      expect(detail.lines).toHaveLength(1);
      const line = detail.lines[0];
      expect(line?.tripId).toBeNull();
      expect(line?.jobId).toBeNull();
      expect(line?.lineAmountPaisa).toBe(2_000_000);
    });

    test("adds a TRIP line with provenance FKs (tripId + jobId) set", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripId = await seedTrip();
      const id = await seedDraft(customerId, { jobId });
      const detail = await service.addLine(id, {
        description: "Haul aggregate",
        quantity: 1,
        unitPricePaisa: 1_500_000,
        tripId,
        jobId,
      });
      const line = detail.lines[0];
      expect(line?.tripId).toBe(tripId);
      expect(line?.jobId).toBe(jobId);
      expect(line?.lineAmountPaisa).toBe(1_500_000);
    });

    test("lineAmountPaisa is the EXACT integer product (never a float)", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      const detail = await service.addLine(id, {
        description: "7 tonnes @ 1,234,567 paisa",
        quantity: 7,
        unitPricePaisa: 1_234_567,
      });
      const amount = detail.lines[0]?.lineAmountPaisa;
      expect(amount).toBe(8_641_969); // 7 * 1_234_567, exact
      expect(Number.isSafeInteger(amount)).toBe(true);
    });

    test("rejects a product that would overflow the int4 column (400)", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      // 2 * 2_000_000_000 = 4e9 > int4 max (2_147_483_647) — overflow guard fires.
      await expect(
        service.addLine(id, { description: "huge", quantity: 2, unitPricePaisa: 2_000_000_000 }),
      ).rejects.toThrow(BadRequestException);
    });

    test("rejects a jobId whose customer differs from the invoice's customer (400)", async () => {
      const customerA = await seedCustomer();
      const customerB = await seedCustomer();
      const jobForB = await seedJob(customerB);
      const id = await seedDraft(customerA);
      await expect(
        service.addLine(id, {
          description: "wrong customer",
          quantity: 1,
          unitPricePaisa: 100,
          jobId: jobForB,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    test("rejects a stale tripId (400 via the P2003 mapper)", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      await expect(
        service.addLine(id, {
          description: "ghost trip",
          quantity: 1,
          unitPricePaisa: 100,
          tripId: "trip_nonexistent",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    test("a line write on an ISSUED invoice is refused (409 — the immutability gate)", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      await service.addLine(id, { description: "first", quantity: 1, unitPricePaisa: 100 });
      await service.issue(id, FY_2082_83);
      await expect(
        service.addLine(id, { description: "after issue", quantity: 1, unitPricePaisa: 100 }),
      ).rejects.toThrow(ConflictException);
    });

    test("a missing invoice → 404", async () => {
      await expect(
        service.addLine("inv_nonexistent", { description: "x", quantity: 1, unitPricePaisa: 100 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // updateLine
  // -------------------------------------------------------------------------
  describe("updateLine()", () => {
    async function seedDraftWithLine(): Promise<{ invoiceId: string; lineId: string }> {
      const customerId = await seedCustomer();
      const invoiceId = await seedDraft(customerId);
      const detail = await service.addLine(invoiceId, {
        description: "original",
        quantity: 2,
        unitPricePaisa: 1_000_000,
      });
      return { invoiceId, lineId: detail.lines[0]!.id };
    }

    test("editing the description alone leaves lineAmountPaisa unchanged", async () => {
      const { invoiceId, lineId } = await seedDraftWithLine();
      const detail = await service.updateLine(invoiceId, lineId, { description: "renamed" });
      expect(detail.lines[0]?.description).toBe("renamed");
      expect(detail.lines[0]?.lineAmountPaisa).toBe(2_000_000); // unchanged
    });

    test("editing quantity re-derives lineAmountPaisa against the stored unit price (merged shape)", async () => {
      const { invoiceId, lineId } = await seedDraftWithLine();
      const detail = await service.updateLine(invoiceId, lineId, { quantity: 5 });
      expect(detail.lines[0]?.quantity).toBe(5);
      expect(detail.lines[0]?.lineAmountPaisa).toBe(5_000_000); // 5 * stored 1_000_000
    });

    test("editing unitPricePaisa re-derives lineAmountPaisa against the stored quantity", async () => {
      const { invoiceId, lineId } = await seedDraftWithLine();
      const detail = await service.updateLine(invoiceId, lineId, { unitPricePaisa: 1_500_000 });
      expect(detail.lines[0]?.lineAmountPaisa).toBe(3_000_000); // stored 2 * 1_500_000
    });

    test("clearing jobId (null) unsets the provenance FK", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const invoiceId = await seedDraft(customerId, { jobId });
      const added = await service.addLine(invoiceId, {
        description: "x",
        quantity: 1,
        unitPricePaisa: 100,
        jobId,
      });
      const detail = await service.updateLine(invoiceId, added.lines[0]!.id, { jobId: null });
      expect(detail.lines[0]?.jobId).toBeNull();
    });

    test("editing a line on an ISSUED invoice is refused (409)", async () => {
      const { invoiceId, lineId } = await seedDraftWithLine();
      await service.issue(invoiceId, FY_2082_83);
      await expect(service.updateLine(invoiceId, lineId, { quantity: 9 })).rejects.toThrow(
        ConflictException,
      );
    });

    test("a missing line → 404", async () => {
      const { invoiceId } = await seedDraftWithLine();
      await expect(
        service.updateLine(invoiceId, "line_nonexistent", { quantity: 9 }),
      ).rejects.toThrow(NotFoundException);
    });

    test("a line that belongs to a different invoice → 404", async () => {
      const a = await seedDraftWithLine();
      const b = await seedDraftWithLine();
      // b's line on a's invoice must not be found.
      await expect(service.updateLine(a.invoiceId, b.lineId, { quantity: 9 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // removeLine
  // -------------------------------------------------------------------------
  describe("removeLine()", () => {
    test("removes a line from a DRAFT", async () => {
      const customerId = await seedCustomer();
      const invoiceId = await seedDraft(customerId);
      const detail = await service.addLine(invoiceId, {
        description: "x",
        quantity: 1,
        unitPricePaisa: 100,
      });
      await service.removeLine(invoiceId, detail.lines[0]!.id);
      const after = await service.findById(invoiceId);
      expect(after?.lines).toHaveLength(0);
    });

    test("removing a line on an ISSUED invoice is refused (409)", async () => {
      const customerId = await seedCustomer();
      const invoiceId = await seedDraft(customerId);
      const detail = await service.addLine(invoiceId, {
        description: "x",
        quantity: 1,
        unitPricePaisa: 100,
      });
      await service.issue(invoiceId, FY_2082_83);
      await expect(service.removeLine(invoiceId, detail.lines[0]!.id)).rejects.toThrow(
        ConflictException,
      );
    });

    test("a missing line → 404", async () => {
      const customerId = await seedCustomer();
      const invoiceId = await seedDraft(customerId);
      await expect(service.removeLine(invoiceId, "line_nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // -------------------------------------------------------------------------
  // buildFromJob
  // -------------------------------------------------------------------------
  describe("buildFromJob()", () => {
    test("builds one line per trip with provenance FKs + operator-keyed amounts", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripA = await seedTrip(TRIP_DATE_A);
      const tripB = await seedTrip(TRIP_DATE_B);
      const invoiceId = await seedDraft(customerId, { jobId });

      const detail = await service.buildFromJob(invoiceId, {
        jobId,
        lines: [
          { tripId: tripA, quantity: 3, unitPricePaisa: 1_500_000, description: "Haul aggregate" },
          { tripId: tripB, quantity: 1, unitPricePaisa: 2_000_000 },
        ],
      });

      expect(detail.lines).toHaveLength(2);
      const lineA = detail.lines.find((l) => l.tripId === tripA);
      const lineB = detail.lines.find((l) => l.tripId === tripB);

      // Provenance FKs stamped (both trip + job).
      expect(lineA?.jobId).toBe(jobId);
      expect(lineB?.jobId).toBe(jobId);
      // Operator-keyed amounts derive the exact integer product.
      expect(lineA?.lineAmountPaisa).toBe(4_500_000); // 3 * 1_500_000
      expect(lineB?.lineAmountPaisa).toBe(2_000_000); // 1 * 2_000_000
    });

    test("each line description carries the trip's date in Bikram Sambat", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripA = await seedTrip(TRIP_DATE_A);
      const invoiceId = await seedDraft(customerId, { jobId });

      const detail = await service.buildFromJob(invoiceId, {
        jobId,
        lines: [
          {
            tripId: tripA,
            quantity: 1,
            unitPricePaisa: 100,
            description: "Haul aggregate Kalimati to Pokhara",
          },
        ],
      });
      const expectedBs = formatNepaliDate(TRIP_DATE_A.toISOString(), { format: "bs" });
      expect(expectedBs).not.toBe("—"); // the fixture date is in-range
      expect(detail.lines[0]?.description).toBe(
        `Haul aggregate Kalimati to Pokhara, ${expectedBs}`,
      );
    });

    test("description falls back to the job's description when a per-line one is omitted", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripA = await seedTrip(TRIP_DATE_B);
      const invoiceId = await seedDraft(customerId, { jobId });

      const detail = await service.buildFromJob(invoiceId, {
        jobId,
        lines: [{ tripId: tripA, quantity: 1, unitPricePaisa: 100 }],
      });
      const expectedBs = formatNepaliDate(TRIP_DATE_B.toISOString(), { format: "bs" });
      expect(detail.lines[0]?.description).toBe(`${JOB_DESCRIPTION}, ${expectedBs}`);
    });

    test("is additive — appends to any existing lines", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripA = await seedTrip();
      const invoiceId = await seedDraft(customerId, { jobId });
      await service.addLine(invoiceId, {
        description: "manual mobilization",
        quantity: 1,
        unitPricePaisa: 500_000,
      });
      const detail = await service.buildFromJob(invoiceId, {
        jobId,
        lines: [{ tripId: tripA, quantity: 1, unitPricePaisa: 100 }],
      });
      expect(detail.lines).toHaveLength(2); // the manual line + the built trip line
    });

    test("rejects a job whose customer differs from the invoice's customer (400)", async () => {
      const customerA = await seedCustomer();
      const customerB = await seedCustomer();
      const jobForB = await seedJob(customerB);
      const tripA = await seedTrip();
      const invoiceId = await seedDraft(customerA);
      await expect(
        service.buildFromJob(invoiceId, {
          jobId: jobForB,
          lines: [{ tripId: tripA, quantity: 1, unitPricePaisa: 100 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    test("rejects a stale tripId (400, pre-checked via TripsService)", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const invoiceId = await seedDraft(customerId, { jobId });
      await expect(
        service.buildFromJob(invoiceId, {
          jobId,
          lines: [{ tripId: "trip_nonexistent", quantity: 1, unitPricePaisa: 100 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    test("a build on an ISSUED invoice is refused (409)", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripA = await seedTrip();
      const invoiceId = await seedDraft(customerId, { jobId });
      await service.addLine(invoiceId, { description: "x", quantity: 1, unitPricePaisa: 100 });
      await service.issue(invoiceId, FY_2082_83);
      await expect(
        service.buildFromJob(invoiceId, {
          jobId,
          lines: [{ tripId: tripA, quantity: 1, unitPricePaisa: 100 }],
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  // -------------------------------------------------------------------------
  // The end-to-end seam: build a draft from a job's trips, then issue it. The
  // lines feed D3's issue() (subtotalPaisa = Σ lineAmountPaisa). Numbers reuse the
  // D2 worked half-up example.
  // -------------------------------------------------------------------------
  describe("build -> issue (the full flow)", () => {
    test("a built draft issues correctly: subtotal sums the lines, snapshot + gapless number assigned", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripA = await seedTrip(TRIP_DATE_A);
      const tripB = await seedTrip(TRIP_DATE_B);
      const invoiceId = await seedDraft(customerId, {
        jobId,
        serviceType: InvoiceServiceType.VEHICLE_HIRE,
      });

      await service.buildFromJob(invoiceId, {
        jobId,
        lines: [
          { tripId: tripA, quantity: 1, unitPricePaisa: 1_000_000 },
          { tripId: tripB, quantity: 1, unitPricePaisa: 235_050 },
        ],
      });

      const issued = await service.issue(invoiceId, FY_2082_83);
      expect(issued.status).toBe(InvoiceStatus.ISSUED);
      expect(issued.number).toBe("INV-2082-83-00001");
      // subtotalPaisa = Σ lineAmountPaisa = 1_000_000 + 235_050 (the D2 example).
      expect(issued.subtotalPaisa).toBe(1_235_050);
      expect(issued.vatPaisa).toBe(160_557);
      expect(issued.grossPaisa).toBe(1_395_607);
      expect(issued.netReceivablePaisa).toBe(1_377_081);
    });
  });

  // -------------------------------------------------------------------------
  // Controller wiring — the routes delegate to the service (which throws the right
  // status). Direct controller calls, like invoices.issue.test.ts.
  // -------------------------------------------------------------------------
  describe("controller wiring", () => {
    test("POST /:id/lines adds a line and returns the updated detail", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      const detail = await controller.addLine(id, {
        description: "x",
        quantity: 2,
        unitPricePaisa: 250,
      });
      expect(detail.lines).toHaveLength(1);
      expect(detail.lines[0]?.lineAmountPaisa).toBe(500);
    });

    test("POST /:id/build-from-job batch-creates trip lines", async () => {
      const customerId = await seedCustomer();
      const jobId = await seedJob(customerId);
      const tripA = await seedTrip();
      const id = await seedDraft(customerId, { jobId });
      const detail = await controller.buildFromJob(id, {
        jobId,
        lines: [{ tripId: tripA, quantity: 1, unitPricePaisa: 100 }],
      });
      expect(detail.lines).toHaveLength(1);
      expect(detail.lines[0]?.tripId).toBe(tripA);
    });

    test("PATCH /:id/lines/:lineId edits a line", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      const added = await controller.addLine(id, {
        description: "x",
        quantity: 1,
        unitPricePaisa: 100,
      });
      const detail = await controller.updateLine(id, added.lines[0]!.id, { quantity: 4 });
      expect(detail.lines[0]?.lineAmountPaisa).toBe(400);
    });

    test("DELETE /:id/lines/:lineId removes a line (void)", async () => {
      const customerId = await seedCustomer();
      const id = await seedDraft(customerId);
      const added = await controller.addLine(id, {
        description: "x",
        quantity: 1,
        unitPricePaisa: 100,
      });
      const result = await controller.removeLine(id, added.lines[0]!.id);
      expect(result).toBeUndefined();
      const after = await service.findById(id);
      expect(after?.lines).toHaveLength(0);
    });
  });
});
