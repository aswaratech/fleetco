import { createHash } from "node:crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { Prisma, UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { sniffDocumentType } from "../src/common/file-signatures";
import {
  DocumentsService,
  entityTypeOf,
  MAX_DOCUMENT_BYTES,
  type UploadedDocumentFile,
} from "../src/modules/documents/documents.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { MockObjectStorage } from "../src/modules/storage/mock.object-storage";
import { ObjectStorage } from "../src/modules/storage/object-storage";
import { resetDb } from "./db";
import { seedCustomer } from "./fixtures/agent";
import { seedDriver, seedUser, seedVehicle } from "./fixtures/trip";

// Integration tests for DocumentsService against real Postgres + the mock
// storage seam (ADR-0049 F2). The service is the SINGLE writer of
// fleet_document rows — these tests pin exactly the invariants the DB
// deliberately does not hold (the no-DB-CHECK decision): exactly-one entity,
// the per-entity category matrix, the sniff-over-mimetype rule, and the
// object-first-row-second / row-first-object-best-effort write orders.

// Honest minimal signatures for each allowlisted type.
const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("fleetco bluebook scan")]);
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fleetco")]);
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF1234"), Buffer.from("WEBPrest")]);
const TEXT_BYTES = Buffer.from("plain text pretending to be a document");

function fileOf(bytes: Buffer, mimetype = "application/octet-stream"): UploadedDocumentFile {
  return { buffer: bytes, mimetype, size: bytes.length, originalname: "upload.bin" };
}

describe("DocumentsService (integration, real Postgres + mock storage)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: DocumentsService;
  const storage = new MockObjectStorage();

  let adminId: string;
  let vehicleId: string;
  let driverId: string;
  let customerId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [DocumentsService, PrismaService, { provide: ObjectStorage, useValue: storage }],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(DocumentsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    storage.puts.length = 0;
    storage.deletes.length = 0;
    await resetDb(prisma);
    adminId = await seedUser(prisma, UserRole.ADMIN);
    vehicleId = (await seedVehicle(prisma, adminId)).id;
    driverId = (await seedDriver(prisma, adminId)).id;
    customerId = (await seedCustomer(prisma, adminId)).id;
  });

  test("sniffDocumentType recognizes PDF plus the three image signatures", () => {
    expect(sniffDocumentType(PDF_BYTES)).toBe("application/pdf");
    expect(sniffDocumentType(PNG_BYTES)).toBe("image/png");
    expect(sniffDocumentType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffDocumentType(WEBP_BYTES)).toBe("image/webp");
    expect(sniffDocumentType(TEXT_BYTES)).toBeNull();
  });

  test("uploads a vehicle Bluebook PDF: sniffed type wins over the lying mimetype, key shape, sha256, entityType", async () => {
    const document = await service.upload(
      { vehicleId, category: "BLUEBOOK", title: "Bluebook scan 2083" },
      fileOf(PDF_BYTES, "image/png"), // the client lies; the sniff is authoritative
      adminId,
    );

    expect(document.entityType).toBe("VEHICLE");
    expect(document.vehicleId).toBe(vehicleId);
    expect(document.driverId).toBeNull();
    expect(document.contentType).toBe("application/pdf");
    expect(document.r2Key).toMatch(new RegExp(`^documents/vehicle/${vehicleId}/[0-9a-f-]+\\.pdf$`));
    expect(document.sizeBytes).toBe(PDF_BYTES.length);
    expect(document.sha256).toBe(createHash("sha256").update(PDF_BYTES).digest("hex"));
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0].key).toBe(document.r2Key);
  });

  test("uploads a driver LICENSE jpeg, a customer AGREEMENT png, and a webp — each entity's matrix admits them", async () => {
    const license = await service.upload(
      { driverId, category: "LICENSE", title: "License scan" },
      fileOf(JPEG_BYTES),
      adminId,
    );
    expect(license.entityType).toBe("DRIVER");
    expect(license.contentType).toBe("image/jpeg");

    const agreement = await service.upload(
      { customerId, category: "AGREEMENT", title: "Haul contract 2083", expiresAt: new Date() },
      fileOf(PNG_BYTES),
      adminId,
    );
    expect(agreement.entityType).toBe("CUSTOMER");

    const other = await service.upload(
      { vehicleId, category: "OTHER", title: "Weighbridge card" },
      fileOf(WEBP_BYTES),
      adminId,
    );
    expect(other.contentType).toBe("image/webp");
  });

  test("rejects unrecognized bytes (400) and an oversize buffer (400) before any storage write", async () => {
    await expect(
      service.upload({ vehicleId, category: "OTHER", title: "junk" }, fileOf(TEXT_BYTES), adminId),
    ).rejects.toBeInstanceOf(BadRequestException);

    const oversize = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x25);
    await expect(
      service.upload({ vehicleId, category: "OTHER", title: "too big" }, fileOf(oversize), adminId),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(storage.puts).toHaveLength(0);
  });

  test("enforces the per-entity category matrix (400): LICENSE on a vehicle, BLUEBOOK on a customer", async () => {
    await expect(
      service.upload(
        { vehicleId, category: "LICENSE", title: "wrong" },
        fileOf(PDF_BYTES),
        adminId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.upload(
        { customerId, category: "BLUEBOOK", title: "wrong" },
        fileOf(PDF_BYTES),
        adminId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.puts).toHaveLength(0);
  });

  test("404s a ghost entity and 400s a zero- or two-entity input (the single-writer re-check)", async () => {
    await expect(
      service.upload(
        { vehicleId: "c00000000ghost", category: "OTHER", title: "x" },
        fileOf(PDF_BYTES),
        adminId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      service.upload({ category: "OTHER", title: "x" }, fileOf(PDF_BYTES), adminId),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.upload(
        { vehicleId, driverId, category: "OTHER", title: "x" },
        fileOf(PDF_BYTES),
        adminId,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test("row-create failure cleans up the stored object best-effort and rethrows", async () => {
    // A cuid-shaped but nonexistent createdById forces P2003 on the row
    // insert AFTER the object was stored — the cleanup path must delete it.
    await expect(
      service.upload(
        { vehicleId, category: "OTHER", title: "orphan probe" },
        fileOf(PDF_BYTES),
        "c00000000nouser",
      ),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(storage.puts).toHaveLength(1);
    expect(storage.deletes).toEqual([storage.puts[0].key]);
  });

  test("list is entity-anchored, category-narrowable, sortable by expiresAt, and clamps take", async () => {
    const early = new Date("2026-08-01T00:00:00Z");
    const late = new Date("2026-12-01T00:00:00Z");
    await service.upload(
      { vehicleId, category: "INSURANCE", title: "policy", expiresAt: late },
      fileOf(PDF_BYTES),
      adminId,
    );
    await service.upload(
      { vehicleId, category: "AGREEMENT", title: "lease", expiresAt: early },
      fileOf(PNG_BYTES),
      adminId,
    );
    await service.upload(
      { driverId, category: "LICENSE", title: "license" },
      fileOf(JPEG_BYTES),
      adminId,
    );

    const vehicleDocs = await service.list({ vehicleId, sortBy: "expiresAt", sortDir: "asc" });
    expect(vehicleDocs.total).toBe(2);
    expect(vehicleDocs.items.map((d) => d.title)).toEqual(["lease", "policy"]);
    expect(vehicleDocs.items.every((d) => d.entityType === "VEHICLE")).toBe(true);

    const narrowed = await service.list({ vehicleId, category: "INSURANCE" });
    expect(narrowed.total).toBe(1);
    expect(narrowed.items[0].title).toBe("policy");

    const clamped = await service.list({ driverId, take: 5000 });
    expect(clamped.take).toBe(200);
    expect(clamped.total).toBe(1);
  });

  test("getContent round-trips the stored bytes with the sniffed type", async () => {
    const document = await service.upload(
      { customerId, category: "AGREEMENT", title: "contract" },
      fileOf(PDF_BYTES),
      adminId,
    );
    const { buffer, contentType } = await service.getContent(document.id);
    expect(contentType).toBe("application/pdf");
    expect(buffer.equals(PDF_BYTES)).toBe(true);
  });

  test("update edits metadata, clears notes/expiry via null, and re-checks the category matrix", async () => {
    const document = await service.upload(
      {
        vehicleId,
        category: "INSURANCE",
        title: "policy",
        notes: "third party",
        expiresAt: new Date(),
      },
      fileOf(PDF_BYTES),
      adminId,
    );

    const renamed = await service.update(document.id, {
      title: "policy 2083",
      notes: null,
      expiresAt: null,
    });
    expect(renamed.title).toBe("policy 2083");
    expect(renamed.notes).toBeNull();
    expect(renamed.expiresAt).toBeNull();

    // A category change must satisfy the (fixed) entity's matrix.
    await expect(service.update(document.id, { category: "LICENSE" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const recategorized = await service.update(document.id, { category: "OTHER" });
    expect(recategorized.category).toBe("OTHER");
  });

  test("delete removes the row first and then the object; getById 404s after", async () => {
    const document = await service.upload(
      { vehicleId, category: "OTHER", title: "temp" },
      fileOf(PNG_BYTES),
      adminId,
    );
    await service.delete(document.id);
    expect(storage.deletes).toContain(document.r2Key);
    await expect(service.getById(document.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  test("an entity with documents delete-blocks at the DB (Restrict → P2003, the house 409 arm's trigger)", async () => {
    await service.upload(
      { vehicleId, category: "BLUEBOOK", title: "bluebook" },
      fileOf(PDF_BYTES),
      adminId,
    );
    await expect(prisma.vehicle.delete({ where: { id: vehicleId } })).rejects.toMatchObject({
      code: "P2003",
    });
  });

  test("entityTypeOf derives from whichever FK is set (no stored column to drift)", () => {
    expect(entityTypeOf({ vehicleId: "v", driverId: null, customerId: null })).toBe("VEHICLE");
    expect(entityTypeOf({ vehicleId: null, driverId: "d", customerId: null })).toBe("DRIVER");
    expect(entityTypeOf({ vehicleId: null, driverId: null, customerId: "c" })).toBe("CUSTOMER");
  });
});
