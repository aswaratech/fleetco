import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { ExpenseCategory, InsuranceType, UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { DocumentsService } from "../src/modules/documents/documents.service";
import { RenewalsService } from "../src/modules/vehicles/renewals.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { MockObjectStorage } from "../src/modules/storage/mock.object-storage";
import { ObjectStorage } from "../src/modules/storage/object-storage";
import { resetDb } from "./db";
import { seedExpenseLog } from "./fixtures/expense-log";
import { seedUser, seedVehicle } from "./fixtures/trip";

// Integration tests for RenewalsService against real Postgres (ADR-0049 F3).
// The renew action is the pair-write the DB cannot express alone: a
// renewal_record row AND the vehicle's matching compliance fields, in ONE
// transaction, with the pre-image expiry snapshotted server-side. These
// tests pin the snapshot, the per-kind field routing, the document/expense
// link rules (through the owning modules' public checks), the rollback
// direction, and the delete-blockers the new Restrict FKs arm.

const OLD_EXPIRY = new Date("2026-08-01T00:00:00Z");
const NEW_EXPIRY = new Date("2027-08-01T00:00:00Z");
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("renewal proof")]);

describe("RenewalsService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: RenewalsService;
  let documents: DocumentsService;
  const storage = new MockObjectStorage();

  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        RenewalsService,
        DocumentsService,
        PrismaService,
        { provide: ObjectStorage, useValue: storage },
      ],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(RenewalsService);
    documents = module.get(DocumentsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    storage.puts.length = 0;
    storage.deletes.length = 0;
    await resetDb(prisma);
    adminId = await seedUser(prisma, UserRole.ADMIN);
  });

  test("an INSURANCE renew snapshots the old expiry, writes the record, and updates the vehicle atomically", async () => {
    const vehicle = await seedVehicle(prisma, adminId, {
      insuranceExpiresAt: OLD_EXPIRY,
      insurer: "Old Insurer",
    });

    const record = await service.renew(
      vehicle.id,
      {
        kind: "INSURANCE",
        newExpiresAt: NEW_EXPIRY,
        insurer: "Shikhar Insurance",
        insurancePolicyNumber: "SHI-MV-2027-001",
        insuranceType: InsuranceType.COMPREHENSIVE,
        notes: "Annual renewal",
      },
      adminId,
    );

    expect(record.kind).toBe("INSURANCE");
    expect(record.previousExpiresAt).toEqual(OLD_EXPIRY);
    expect(record.newExpiresAt).toEqual(NEW_EXPIRY);
    expect(record.renewedAt).toBeInstanceOf(Date); // defaulted to now

    const updated = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(updated.insuranceExpiresAt).toEqual(NEW_EXPIRY);
    expect(updated.insurer).toBe("Shikhar Insurance");
    expect(updated.insurancePolicyNumber).toBe("SHI-MV-2027-001");
    expect(updated.insuranceType).toBe(InsuranceType.COMPREHENSIVE);
    // The other compliance families are untouched.
    expect(updated.bluebookExpiresAt).toBeNull();
    expect(updated.routePermitExpiresAt).toBeNull();
  });

  test("a first-ever renewal snapshots previousExpiresAt as null; an omitted number leaves the existing value", async () => {
    const vehicle = await seedVehicle(prisma, adminId, {
      bluebookNumber: "BB-3-045-2075",
      bluebookExpiresAt: null,
    });

    const record = await service.renew(
      vehicle.id,
      { kind: "BLUEBOOK", newExpiresAt: NEW_EXPIRY },
      adminId,
    );

    expect(record.previousExpiresAt).toBeNull();
    const updated = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(updated.bluebookExpiresAt).toEqual(NEW_EXPIRY);
    expect(updated.bluebookNumber).toBe("BB-3-045-2075"); // conditional pass-through
  });

  test("404s a ghost vehicle", async () => {
    await expect(
      service.renew("c0000000ghost", { kind: "BLUEBOOK", newExpiresAt: NEW_EXPIRY }, adminId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test("links a matching-category proof document on the same vehicle; rejects wrong category, foreign vehicle, and ghosts (400)", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { routePermitExpiresAt: OLD_EXPIRY });
    const otherVehicle = await seedVehicle(prisma, adminId);

    const proof = await documents.upload(
      { vehicleId: vehicle.id, category: "ROUTE_PERMIT", title: "Permit 2083" },
      {
        buffer: PDF_BYTES,
        mimetype: "application/pdf",
        size: PDF_BYTES.length,
        originalname: "p.pdf",
      },
      adminId,
    );
    const wrongCategory = await documents.upload(
      { vehicleId: vehicle.id, category: "OTHER", title: "misc" },
      {
        buffer: PDF_BYTES,
        mimetype: "application/pdf",
        size: PDF_BYTES.length,
        originalname: "m.pdf",
      },
      adminId,
    );
    const foreign = await documents.upload(
      { vehicleId: otherVehicle.id, category: "ROUTE_PERMIT", title: "other permit" },
      {
        buffer: PDF_BYTES,
        mimetype: "application/pdf",
        size: PDF_BYTES.length,
        originalname: "o.pdf",
      },
      adminId,
    );

    const record = await service.renew(
      vehicle.id,
      { kind: "ROUTE_PERMIT", newExpiresAt: NEW_EXPIRY, documentId: proof.id },
      adminId,
    );
    expect(record.documentId).toBe(proof.id);

    for (const documentId of [wrongCategory.id, foreign.id, "c0000000gone"]) {
      await expect(
        service.renew(
          vehicle.id,
          { kind: "ROUTE_PERMIT", newExpiresAt: NEW_EXPIRY, documentId },
          adminId,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  test("links a per-kind-category cost expense; rejects the wrong category and a foreign vehicle's expense (400)", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { insuranceExpiresAt: OLD_EXPIRY });
    const otherVehicle = await seedVehicle(prisma, adminId);

    const premium = await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      category: ExpenseCategory.INSURANCE,
    });
    const toll = await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      category: ExpenseCategory.TOLL,
    });
    const foreignPremium = await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: otherVehicle.id,
      category: ExpenseCategory.INSURANCE,
    });

    const record = await service.renew(
      vehicle.id,
      { kind: "INSURANCE", newExpiresAt: NEW_EXPIRY, expenseLogId: premium.id },
      adminId,
    );
    expect(record.expenseLogId).toBe(premium.id);

    for (const expenseLogId of [toll.id, foreignPremium.id, "c0000000gone"]) {
      await expect(
        service.renew(
          vehicle.id,
          { kind: "INSURANCE", newExpiresAt: NEW_EXPIRY, expenseLogId },
          adminId,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    // BLUEBOOK admits PERMIT or OTHER (there is no BLUEBOOK expense category).
    const fee = await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      category: ExpenseCategory.OTHER,
    });
    const bluebook = await service.renew(
      vehicle.id,
      { kind: "BLUEBOOK", newExpiresAt: NEW_EXPIRY, expenseLogId: fee.id },
      adminId,
    );
    expect(bluebook.expenseLogId).toBe(fee.id);
  });

  test("a mid-transaction failure rolls the pair back — no record AND no vehicle change", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { insuranceExpiresAt: OLD_EXPIRY });

    // A cuid-shaped but nonexistent createdById fails the record insert
    // (P2003) INSIDE the transaction; the vehicle update must not survive.
    await expect(
      service.renew(vehicle.id, { kind: "INSURANCE", newExpiresAt: NEW_EXPIRY }, "c0000000nouser"),
    ).rejects.toThrow();

    expect(await prisma.renewalRecord.count()).toBe(0);
    const untouched = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } });
    expect(untouched.insuranceExpiresAt).toEqual(OLD_EXPIRY);
  });

  test("list returns the vehicle's history newest-first, filters by kind, clamps take, and 404s a ghost", async () => {
    const vehicle = await seedVehicle(prisma, adminId, {
      bluebookExpiresAt: OLD_EXPIRY,
      insuranceExpiresAt: OLD_EXPIRY,
    });
    await service.renew(
      vehicle.id,
      { kind: "BLUEBOOK", newExpiresAt: NEW_EXPIRY, renewedAt: new Date("2026-01-10") },
      adminId,
    );
    await service.renew(
      vehicle.id,
      { kind: "INSURANCE", newExpiresAt: NEW_EXPIRY, renewedAt: new Date("2026-06-10") },
      adminId,
    );

    const all = await service.list(vehicle.id, {});
    expect(all.total).toBe(2);
    expect(all.items.map((r) => r.kind)).toEqual(["INSURANCE", "BLUEBOOK"]); // newest first
    // The F5 read shape: link summaries are nested keys, null when unlinked.
    expect(all.items[0].document).toBeNull();
    expect(all.items[0].expenseLog).toBeNull();

    const filtered = await service.list(vehicle.id, { kind: "BLUEBOOK" });
    expect(filtered.total).toBe(1);

    const clamped = await service.list(vehicle.id, { take: 9999 });
    expect(clamped.take).toBe(200);

    await expect(service.list("c0000000ghost", {})).rejects.toBeInstanceOf(NotFoundException);
  });

  test("the new Restrict FKs arm the delete-blockers: a linked proof document 409s; a linked expense P2003s", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { insuranceExpiresAt: OLD_EXPIRY });
    const proof = await documents.upload(
      { vehicleId: vehicle.id, category: "INSURANCE", title: "policy" },
      {
        buffer: PDF_BYTES,
        mimetype: "application/pdf",
        size: PDF_BYTES.length,
        originalname: "p.pdf",
      },
      adminId,
    );
    const premium = await seedExpenseLog(prisma, {
      createdById: adminId,
      vehicleId: vehicle.id,
      category: ExpenseCategory.INSURANCE,
    });
    await service.renew(
      vehicle.id,
      {
        kind: "INSURANCE",
        newExpiresAt: NEW_EXPIRY,
        documentId: proof.id,
        expenseLogId: premium.id,
      },
      adminId,
    );

    // The F5 read shape carries the linked summaries for the history table.
    const history = await service.list(vehicle.id, {});
    expect(history.items[0].document).toEqual({ id: proof.id, title: "policy" });
    expect(history.items[0].expenseLog).toEqual({
      id: premium.id,
      amountPaisa: premium.amountPaisa,
    });

    // DocumentsService maps the P2003 to the house 409 (the F2 arm, now live).
    await expect(documents.delete(proof.id)).rejects.toBeInstanceOf(ConflictException);
    // The raw FK behind the expense-logs service's existing 409 arm.
    await expect(prisma.expenseLog.delete({ where: { id: premium.id } })).rejects.toMatchObject({
      code: "P2003",
    });
  });
});
