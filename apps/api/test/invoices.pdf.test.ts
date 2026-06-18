import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  InternalServerErrorException,
  StreamableFile,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { InvoiceServiceType, InvoiceStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { InvoiceNumberingService } from "../src/modules/invoices/invoice-numbering.service";
import {
  InvoicePdfRenderer,
  type InvoiceRenderModel,
} from "../src/modules/invoices/invoice-pdf-renderer";
import { InvoiceSettingsService } from "../src/modules/invoices/invoice-settings.service";
import { InvoicesController } from "../src/modules/invoices/invoices.controller";
import { InvoicesService } from "../src/modules/invoices/invoices.service";
import {
  ObjectStorage,
  ObjectStorageObjectNotFoundError,
  type PutObjectInput,
} from "../src/modules/invoices/object-storage";
import { JobsService } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsService } from "../src/modules/trips/trips.service";
import { resetDb } from "./db";

// D5 — the PDF render + the first in-app R2 store wired into the invoice lifecycle
// (ADR-0039 c6–7), against real Postgres with the renderer + storage MOCKED (no
// network, no real PDF bytes). This file owns the render/store-specific assertions
// (render-once / store-once / pdfR2Key set / draft preview watermarked + no R2
// write / the supplier-PAN & R2 preconditions firing BEFORE any render / the
// download streaming the stored object / the side-effect-ordering rollback
// safety). The frozen-snapshot + numbering + lifecycle assertions live in
// invoices.issue.test.ts; the renderer's real %PDF output in
// invoice-pdf-renderer.test.ts; the storage wrapper in object-storage.test.ts.

const FY_2082_83 = new Date("2025-08-01T00:00:00.000Z");

// The marker bytes the recording renderer returns — a valid-looking PDF header so
// the assertions read naturally, but NOT a real render (that is the renderer's own
// test). Identity-compared end to end: render → storage.put body → R2 → download.
const RENDERED_PDF = Buffer.from("%PDF-1.7\nFLEETCO-D5-TEST-RENDER\n%%EOF\n");

// Recording test doubles, mutated per test (the supplierPan mutable pattern).
const rendererCalls: InvoiceRenderModel[] = [];
let rendererError: Error | null = null;
const recordingRenderer: InvoicePdfRenderer = {
  render(model: InvoiceRenderModel): Promise<Buffer> {
    rendererCalls.push(model);
    return rendererError !== null ? Promise.reject(rendererError) : Promise.resolve(RENDERED_PDF);
  },
};

const storagePuts: PutObjectInput[] = [];
const storageMap = new Map<string, Buffer>();
let storageConfigured = true;
let storagePutError: Error | null = null;
const recordingStorage: ObjectStorage = {
  isConfigured: () => storageConfigured,
  put(input: PutObjectInput): Promise<void> {
    storagePuts.push(input);
    if (storagePutError !== null) {
      return Promise.reject(storagePutError);
    }
    storageMap.set(input.key, input.body);
    return Promise.resolve();
  },
  get(key: string): Promise<Buffer> {
    const bytes = storageMap.get(key);
    return bytes !== undefined
      ? Promise.resolve(bytes)
      : Promise.reject(new ObjectStorageObjectNotFoundError(key));
  },
};

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

describe("Invoice PDF render + R2 store (integration, real Postgres; renderer + R2 mocked)", () => {
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
        {
          provide: InvoiceSettingsService,
          useValue: { getSupplierPan: () => supplierPan, getSupplierName: () => "FleetCo" },
        },
        // The D5 render+store collaborators — recording doubles so the assertions
        // count render/store calls and identity-compare the bytes, with no network.
        { provide: InvoicePdfRenderer, useValue: recordingRenderer },
        { provide: ObjectStorage, useValue: recordingStorage },
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
    // Reset the recording doubles + the PAN/store flags to the happy path.
    rendererCalls.length = 0;
    rendererError = null;
    storagePuts.length = 0;
    storageMap.clear();
    storageConfigured = true;
    storagePutError = null;
    supplierPan = "TEST-SUPPLIER-PAN";
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: { id: adminId, email: `admin-${adminId}@fleetco.test`, name: "Test Admin" },
    });
  });

  async function seedCustomer(panNumber?: string): Promise<string> {
    const customer = await prisma.customer.create({
      data: {
        name: `Acme ${randomUUID().slice(0, 6)}`,
        phone: "+977-9800000000",
        panNumber: panNumber ?? null,
        createdById: adminId,
      },
    });
    return customer.id;
  }

  async function seedDraftWithLines(opts: {
    lineAmounts: number[];
    serviceType?: InvoiceServiceType | null;
    customerPan?: string;
  }): Promise<string> {
    const customerId = await seedCustomer(opts.customerPan);
    const invoice = await prisma.invoice.create({
      data: {
        customerId,
        createdById: adminId,
        serviceType:
          opts.serviceType === undefined ? InvoiceServiceType.VEHICLE_HIRE : opts.serviceType,
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

  describe("issue() renders + stores the frozen PDF exactly once", () => {
    test("renders once, hands the bytes to storage.put, and sets pdfR2Key", async () => {
      const id = await seedDraftWithLines({
        lineAmounts: [1_000_000, 235_050],
        customerPan: "301234567",
      });
      const issued = await service.issue(id, FY_2082_83);

      // Rendered exactly once, with the ISSUED model (the gapless number, no
      // watermark — this is the legal artifact, ADR-0039 c7).
      expect(rendererCalls).toHaveLength(1);
      expect(rendererCalls[0]?.watermark).toBeNull();
      expect(rendererCalls[0]?.number).toBe(issued.number);
      expect(rendererCalls[0]?.issuedAtIso).toBe(FY_2082_83.toISOString());

      // The model carries the frozen breakdown + the supplier/buyer identity.
      expect(rendererCalls[0]?.supplierPan).toBe("TEST-SUPPLIER-PAN");
      expect(rendererCalls[0]?.supplierName).toBe("FleetCo");
      expect(rendererCalls[0]?.customerPan).toBe("301234567");
      expect(rendererCalls[0]?.tax?.grossPaisa).toBe(issued.grossPaisa);

      // Stored exactly once: the renderer's bytes handed to put as application/pdf
      // at the invoice's key, and pdfR2Key recorded on the row.
      expect(storagePuts).toHaveLength(1);
      expect(storagePuts[0]?.key).toBe(`invoices/${id}.pdf`);
      expect(storagePuts[0]?.contentType).toBe("application/pdf");
      expect(storagePuts[0]?.body).toBe(RENDERED_PDF);
      expect(issued.pdfR2Key).toBe(`invoices/${id}.pdf`);
    });

    test("a render failure rolls back the whole issue — no number burned, no store, still DRAFT", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [100] });
      rendererError = new Error("renderer exploded");

      await expect(service.issue(id, FY_2082_83)).rejects.toThrow("renderer exploded");

      // Render is BEFORE the store, so the store was never reached.
      expect(rendererCalls).toHaveLength(1);
      expect(storagePuts).toHaveLength(0);
      // The transaction rolled back: the draft is untouched and NO number burned.
      const after = await service.findByIdRaw(id);
      expect(after?.status).toBe(InvoiceStatus.DRAFT);
      expect(after?.number).toBeNull();
      expect(after?.pdfR2Key).toBeNull();
      expect(await prisma.invoiceNumberSequence.count()).toBe(0);
    });

    test("a store failure rolls back the whole issue — no number burned, still DRAFT", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [100] });
      storagePutError = new Error("R2 down");

      await expect(service.issue(id, FY_2082_83)).rejects.toThrow("R2 down");

      // The render happened (it precedes the store), the store was attempted and
      // failed → the transaction rolled back: no burned number, still DRAFT.
      expect(rendererCalls).toHaveLength(1);
      expect(storagePuts).toHaveLength(1);
      const after = await service.findByIdRaw(id);
      expect(after?.status).toBe(InvoiceStatus.DRAFT);
      expect(after?.number).toBeNull();
      expect(after?.pdfR2Key).toBeNull();
      expect(await prisma.invoiceNumberSequence.count()).toBe(0);
    });
  });

  describe("issue() preconditions fire BEFORE any render or store", () => {
    test("supplier PAN not configured → 422, with no render and no store", async () => {
      supplierPan = null;
      const id = await seedDraftWithLines({ lineAmounts: [100] });

      await expect(service.issue(id, FY_2082_83)).rejects.toThrow(UnprocessableEntityException);
      expect(rendererCalls).toHaveLength(0);
      expect(storagePuts).toHaveLength(0);
      const after = await service.findByIdRaw(id);
      expect(after?.status).toBe(InvoiceStatus.DRAFT);
      expect(await prisma.invoiceNumberSequence.count()).toBe(0);
    });

    test("R2 not configured → 422, with no render and no store", async () => {
      storageConfigured = false;
      const id = await seedDraftWithLines({ lineAmounts: [100] });

      await expect(service.issue(id, FY_2082_83)).rejects.toThrow(UnprocessableEntityException);
      expect(rendererCalls).toHaveLength(0);
      expect(storagePuts).toHaveLength(0);
      const after = await service.findByIdRaw(id);
      expect(after?.status).toBe(InvoiceStatus.DRAFT);
      expect(after?.number).toBeNull();
      expect(await prisma.invoiceNumberSequence.count()).toBe(0);
    });
  });

  describe("getPdf() — the anti-tamper download/preview split", () => {
    test("an ISSUED invoice streams the STORED object and is never re-rendered", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [1_000_000] });
      const issued = await service.issue(id, FY_2082_83);
      expect(rendererCalls).toHaveLength(1); // rendered once at issue

      // A download AFTER issue must come from R2 — no second render.
      rendererCalls.length = 0;
      const { buffer, filename } = await service.getPdf(id);
      expect(rendererCalls).toHaveLength(0); // NOT re-rendered (the freeze)
      expect(buffer).toBe(RENDERED_PDF); // the exact stored bytes
      expect(filename).toBe(`${issued.number}.pdf`);
      // No new store either.
      expect(storagePuts).toHaveLength(1);
    });

    test("a DRAFT preview regenerates a watermarked PDF with NO R2 write", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [1_000_000], customerPan: "301234567" });

      const { buffer, filename } = await service.getPdf(id);

      // Regenerated on demand (rendered), watermarked, unnumbered, provisional tax.
      expect(rendererCalls).toHaveLength(1);
      expect(rendererCalls[0]?.watermark).toBe("DRAFT — NOT A VALID TAX INVOICE");
      expect(rendererCalls[0]?.number).toBeNull();
      expect(rendererCalls[0]?.issuedAtIso).toBeNull();
      expect(rendererCalls[0]?.tax).not.toBeNull(); // serviceType set → provisional breakdown
      expect(buffer).toBe(RENDERED_PDF);
      expect(filename).toBe(`invoice-draft-${id}.pdf`);
      // The load-bearing freeze rule: a draft preview NEVER writes to R2.
      expect(storagePuts).toHaveLength(0);
    });

    test("a DRAFT preview with no serviceType yet renders with tax === null (still no R2 write)", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [1_000_000], serviceType: null });

      await service.getPdf(id);

      expect(rendererCalls).toHaveLength(1);
      expect(rendererCalls[0]?.watermark).toBe("DRAFT — NOT A VALID TAX INVOICE");
      expect(rendererCalls[0]?.tax).toBeNull();
      expect(storagePuts).toHaveLength(0);
    });

    test("getPdf on a missing invoice → 404", async () => {
      await expect(service.getPdf("nonexistent-id")).rejects.toThrow(/not found/i);
      expect(rendererCalls).toHaveLength(0);
    });

    test("an ISSUED invoice with a null pdfR2Key (internal inconsistency) → 500, never re-rendered", async () => {
      // Construct the impossible-via-issue() state directly to prove the defensive
      // guard: an issued invoice with no stored key is surfaced as 500, NOT
      // silently re-rendered (which would break the anti-tamper freeze).
      const customerId = await seedCustomer();
      const invoice = await prisma.invoice.create({
        data: {
          customerId,
          createdById: adminId,
          status: InvoiceStatus.ISSUED,
          number: "INV-2082-83-09999",
          issuedAt: FY_2082_83,
          serviceType: InvoiceServiceType.VEHICLE_HIRE,
          pdfR2Key: null,
        },
      });
      await prisma.invoiceLine.create({
        data: {
          invoiceId: invoice.id,
          description: "x",
          quantity: 1,
          unitPricePaisa: 100,
          lineAmountPaisa: 100,
        },
      });

      await expect(service.getPdf(invoice.id)).rejects.toThrow(InternalServerErrorException);
      expect(rendererCalls).toHaveLength(0); // never re-rendered
    });
  });

  describe("controller GET /:id/pdf streams a StreamableFile", () => {
    test("an issued invoice streams the stored PDF inline, named by its number", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [1_000_000] });
      const issued = await service.issue(id, FY_2082_83);

      const result = await controller.getPdf(id);
      expect(result).toBeInstanceOf(StreamableFile);
      const headers = result.getHeaders();
      expect(headers.type).toBe("application/pdf");
      expect(headers.disposition).toContain(`${issued.number}.pdf`);
      // The streamed bytes are the stored object.
      const streamed = await readStream(result.getStream());
      expect(streamed.equals(RENDERED_PDF)).toBe(true);
    });

    test("a draft streams a watermarked preview named invoice-draft-<id>", async () => {
      const id = await seedDraftWithLines({ lineAmounts: [1_000_000] });
      const result = await controller.getPdf(id);
      expect(result).toBeInstanceOf(StreamableFile);
      expect(result.getHeaders().disposition).toContain(`invoice-draft-${id}.pdf`);
      expect(rendererCalls[0]?.watermark).toBe("DRAFT — NOT A VALID TAX INVOICE");
      expect(storagePuts).toHaveLength(0);
    });
  });
});
