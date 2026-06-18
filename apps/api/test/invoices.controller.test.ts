import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type INestApplication,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { CustomerStatus, DocumentType, InvoiceServiceType, InvoiceStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { InvoiceNumberingService } from "../src/modules/invoices/invoice-numbering.service";
import { InvoiceSettingsService } from "../src/modules/invoices/invoice-settings.service";
import { InvoicesController } from "../src/modules/invoices/invoices.controller";
import { InvoicesService } from "../src/modules/invoices/invoices.service";
import {
  CreateInvoiceSchema,
  ListInvoicesQuerySchema,
  UpdateInvoiceSchema,
} from "../src/modules/invoices/invoices.schemas";
import { JobsService } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TripsService } from "../src/modules/trips/trips.service";
import { resetDb } from "./db";

// Tests for InvoicesController, focused on the D1 read contract. Two-layer
// structure mirrors customers.controller.test.ts:
//   1. Schema/pipe layer: ZodValidationPipe over ListInvoicesQuerySchema — pure
//      code, no Nest boot. Whether a bogus key / bad enum / off-whitelist sortBy /
//      over-ceiling take surfaces as HTTP 400 is a property of the schema's
//      .strict() + transforms + the pipe's ZodError -> BadRequestException.
//   2. Controller layer: InvoicesController.list() / getById() against a real
//      PrismaService + InvoicesService, with AuthGuard overridden to pass-through.
//      The response shape { items, total, skip, take, sortBy, sortDir } and the
//      404 mapping are asserted here.

describe("InvoicesController list-query schema (D1 contract)", () => {
  const pipe = new ZodValidationPipe(ListInvoicesQuerySchema);

  test("bogus query key (e.g. ?staus=DRAFT) → BadRequestException (HTTP 400)", () => {
    expect(() => pipe.transform({ staus: "DRAFT" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    // InvoiceStatus has only DRAFT/ISSUED/CANCELLED; any other value fails.
    expect(() => pipe.transform({ status: "PENDING" })).toThrow(BadRequestException);
  });

  test("invalid documentType enum value → BadRequestException", () => {
    expect(() => pipe.transform({ documentType: "RECEIPT" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy → BadRequestException", () => {
    // The whitelist is createdAt / number. Any other column (including a frozen
    // money column) returns 400 — both a schema check and an information-
    // disclosure defense: refusing to sort by grossPaisa prevents leaking amount
    // ordering over the Tier-3 financial columns.
    expect(() => pipe.transform({ sortBy: "grossPaisa" })).toThrow(BadRequestException);
  });

  test("sortBy=customerId is rejected (off-whitelist)", () => {
    expect(() => pipe.transform({ sortBy: "customerId" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException with field-named message", () => {
    try {
      pipe.transform({ take: "999" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message.toLowerCase()).toContain("take");
    }
  });

  test("skip below zero → BadRequestException", () => {
    expect(() => pipe.transform({ skip: "-1" })).toThrow(BadRequestException);
  });

  test("non-integer take → BadRequestException", () => {
    expect(() => pipe.transform({ take: "abc" })).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (string → number, csv → array)", () => {
    const result = pipe.transform({
      status: "DRAFT,ISSUED",
      documentType: "INVOICE,CREDIT_NOTE",
      customerId: "cust_123",
      sortBy: "number",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual([InvoiceStatus.DRAFT, InvoiceStatus.ISSUED]);
    expect(result.documentType).toEqual([DocumentType.INVOICE, DocumentType.CREDIT_NOTE]);
    expect(result.customerId).toBe("cust_123");
    expect(result.sortBy).toBe("number");
    expect(result.sortDir).toBe("asc");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → undefined fields (defaults applied at controller/service)", () => {
    const result = pipe.transform({});
    expect(result.status).toBeUndefined();
    expect(result.documentType).toBeUndefined();
    expect(result.customerId).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });

  test("empty-string customerId normalizes to undefined (no filter)", () => {
    const result = pipe.transform({ customerId: "" });
    expect(result.customerId).toBeUndefined();
  });
});

describe("InvoicesController.list (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: InvoicesController;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        InvoicesService,
        InvoiceNumberingService,
        InvoiceSettingsService,
        // D4: InvoicesService now reads jobs/trips through these public interfaces
        // (TripsService needs DriverScopeService).
        JobsService,
        TripsService,
        DriverScopeService,
        PrismaService,
        // AUTH is required by AuthGuard's constructor. The override below replaces
        // the guard itself, but Nest still resolves its dependencies — provide a
        // benign stub so DI does not fail on AUTH lookup.
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(InvoicesController);
  });

  afterAll(async () => {
    await app.close();
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

  async function seedCustomer(name: string, status: CustomerStatus = CustomerStatus.ACTIVE) {
    return prisma.customer.create({
      data: { name, phone: "+977-9800000000", status, createdById: adminId },
    });
  }

  async function seedInvoice(customerId: string, status: InvoiceStatus, number: string | null) {
    return prisma.invoice.create({
      data: { customerId, status, number, createdById: adminId },
    });
  }

  test("valid filter+sort+page returns response shape { items, total, skip, take, sortBy, sortDir }", async () => {
    const customer = await seedCustomer("Acme Builders");
    await seedInvoice(customer.id, InvoiceStatus.ISSUED, "INV-2082-83-00001");
    await seedInvoice(customer.id, InvoiceStatus.DRAFT, null);

    const response = await controller.list({
      status: [InvoiceStatus.ISSUED],
      sortBy: "number",
      sortDir: "asc",
      skip: 0,
      take: 10,
    });

    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "number",
      sortDir: "asc",
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.number).toBe("INV-2082-83-00001");
    expect(response.items[0]?.status).toBe(InvoiceStatus.ISSUED);
    // The slim list projection carries the nested customer name.
    expect(response.items[0]?.customer.name).toBe("Acme Builders");
  });

  test("empty query → controller applies defaults (sortBy=createdAt, sortDir=desc, skip=0, take=20)", async () => {
    const customer = await seedCustomer("Acme");
    await seedInvoice(customer.id, InvoiceStatus.DRAFT, null);

    const response = await controller.list({});
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("response.items and response.total agree when no pagination is applied", async () => {
    const customer = await seedCustomer("Acme");
    await seedInvoice(customer.id, InvoiceStatus.DRAFT, null);
    await seedInvoice(customer.id, InvoiceStatus.ISSUED, "INV-2082-83-00002");
    await seedInvoice(customer.id, InvoiceStatus.CANCELLED, null);

    const response = await controller.list({});
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });
});

describe("InvoicesController.getById (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: InvoicesController;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        InvoicesService,
        InvoiceNumberingService,
        InvoiceSettingsService,
        // D4 constructor deps (build-from-job/line reads + TripsService's scope dep).
        JobsService,
        TripsService,
        DriverScopeService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(InvoicesController);
  });

  afterAll(async () => {
    await app.close();
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

  test("returns the invoice with its nested customer and lines when present", async () => {
    const customer = await prisma.customer.create({
      data: { name: "Himalaya Cement", phone: "+977-9800000000", createdById: adminId },
    });
    const invoice = await prisma.invoice.create({
      data: { customerId: customer.id, createdById: adminId },
    });
    await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id,
        description: "Mobilization fee",
        quantity: 1,
        unitPricePaisa: 500_000,
        lineAmountPaisa: 500_000,
      },
    });

    const fetched = await controller.getById(invoice.id);
    expect(fetched.id).toBe(invoice.id);
    expect(fetched.customer.name).toBe("Himalaya Cement");
    expect(fetched.lines).toHaveLength(1);
    expect(fetched.lines[0]?.description).toBe("Mobilization fee");
  });

  test("unknown id → NotFoundException (HTTP 404) with the id named in the message", async () => {
    try {
      await controller.getById("nonexistent-invoice-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-invoice-id");
    }
  });
});

// D3 write-path schema-pipe layer (pure — no Nest boot). The .strict() create /
// update schemas are the FIRST line of the immutability defense: number, the
// frozen tax amounts, status, and documentType are not in the shape, so a client
// cannot set them on ANY invoice (the service then refuses any edit on a
// non-DRAFT row — invoices.service.test.ts covers that half).
describe("InvoicesController create/update schema (D3 write contract)", () => {
  const createPipe = new ZodValidationPipe(CreateInvoiceSchema);
  const updatePipe = new ZodValidationPipe(UpdateInvoiceSchema);

  test("create: missing customerId → 400", () => {
    expect(() => createPipe.transform({})).toThrow(BadRequestException);
  });

  test("create: a bogus key → 400 (.strict())", () => {
    expect(() => createPipe.transform({ customerId: "c1", bogus: 1 })).toThrow(BadRequestException);
  });

  test("create: a client-set number is rejected (immutability — number is issue-only)", () => {
    expect(() => createPipe.transform({ customerId: "c1", number: "INV-2082-83-00001" })).toThrow(
      BadRequestException,
    );
  });

  test("create: a client-set tax amount is rejected (the snapshot is frozen at issue)", () => {
    expect(() => createPipe.transform({ customerId: "c1", grossPaisa: 1 })).toThrow(
      BadRequestException,
    );
  });

  test("create: a client-set status is rejected (status moves via issue/cancel only)", () => {
    expect(() => createPipe.transform({ customerId: "c1", status: "ISSUED" })).toThrow(
      BadRequestException,
    );
  });

  test("create: an invalid serviceType → 400", () => {
    expect(() => createPipe.transform({ customerId: "c1", serviceType: "AIR_FREIGHT" })).toThrow(
      BadRequestException,
    );
  });

  test("create: a non-integer / negative discount → 400", () => {
    expect(() => createPipe.transform({ customerId: "c1", discountPaisa: 1.5 })).toThrow(
      BadRequestException,
    );
    expect(() => createPipe.transform({ customerId: "c1", discountPaisa: -1 })).toThrow(
      BadRequestException,
    );
  });

  test("create: a valid header passes through", () => {
    const result = createPipe.transform({
      customerId: "c1",
      jobId: "j1",
      serviceType: "VEHICLE_HIRE",
      discountPaisa: 5000,
    });
    expect(result).toEqual({
      customerId: "c1",
      jobId: "j1",
      serviceType: "VEHICLE_HIRE",
      discountPaisa: 5000,
    });
  });

  test("update: an empty body → 400 (at least one field)", () => {
    expect(() => updatePipe.transform({})).toThrow(BadRequestException);
  });

  test("update: a financial-but-frozen key is rejected (number / amounts / status)", () => {
    expect(() => updatePipe.transform({ number: "X" })).toThrow(BadRequestException);
    expect(() => updatePipe.transform({ subtotalPaisa: 1 })).toThrow(BadRequestException);
    expect(() => updatePipe.transform({ status: "ISSUED" })).toThrow(BadRequestException);
  });

  test("update: a single DRAFT-editable field passes", () => {
    expect(updatePipe.transform({ discountPaisa: 0 })).toEqual({ discountPaisa: 0 });
  });
});

describe("InvoicesController write path (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: InvoicesController;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [InvoicesController],
      providers: [
        InvoicesService,
        InvoiceNumberingService,
        InvoiceSettingsService,
        // D4 constructor deps (build-from-job/line reads + TripsService's scope dep).
        JobsService,
        TripsService,
        DriverScopeService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();
    prisma = module.get(PrismaService);
    controller = module.get(InvoicesController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: { id: adminId, email: `admin-${adminId}@fleetco.test`, name: "Test Admin" },
    });
  });

  function requestAs(userId: string): AuthenticatedRequest {
    return { session: { user: { id: userId } } } as unknown as AuthenticatedRequest;
  }

  async function seedCustomerRow(name: string) {
    return prisma.customer.create({
      data: { name, phone: "+977-9800000000", createdById: adminId },
    });
  }

  test("create pulls createdById from the session (never the body) and returns a DRAFT", async () => {
    const customer = await seedCustomerRow("Acme Builders");
    const created = await controller.create(
      { customerId: customer.id, serviceType: InvoiceServiceType.VEHICLE_HIRE },
      requestAs(adminId),
    );
    expect(created.status).toBe(InvoiceStatus.DRAFT);
    expect(created.createdById).toBe(adminId);
    expect(created.number).toBeNull();
  });

  test("update on a missing row → NotFoundException (404)", async () => {
    await expect(controller.update("nope", { discountPaisa: 1 })).rejects.toThrow(
      NotFoundException,
    );
  });

  test("update on an ISSUED row → ConflictException (409) bubbles from the service", async () => {
    const customer = await seedCustomerRow("Acme");
    const issued = await prisma.invoice.create({
      data: {
        customerId: customer.id,
        createdById: adminId,
        status: InvoiceStatus.ISSUED,
        number: "INV-2082-83-00001",
      },
    });
    await expect(controller.update(issued.id, { discountPaisa: 0 })).rejects.toThrow(
      ConflictException,
    );
  });

  test("cancel transitions a DRAFT to CANCELLED; cancel on a missing row → 404", async () => {
    const customer = await seedCustomerRow("Acme");
    const draft = await controller.create({ customerId: customer.id }, requestAs(adminId));
    const cancelled = await controller.cancel(draft.id);
    expect(cancelled.status).toBe(InvoiceStatus.CANCELLED);

    await expect(controller.cancel("nope")).rejects.toThrow(NotFoundException);
  });
});
