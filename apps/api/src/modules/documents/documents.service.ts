import { createHash, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type DocumentCategory, type FleetDocument } from "@prisma/client";

import { sniffDocumentType } from "../../common/file-signatures";

// PrismaService and ObjectStorage are injected by NestJS via
// emitDecoratorMetadata; the class references must remain value imports so
// the DI container can resolve them (the standard override).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ObjectStorage } from "../storage/object-storage";
import {
  CUSTOMER_DOCUMENT_CATEGORIES,
  DRIVER_DOCUMENT_CATEGORIES,
  VEHICLE_DOCUMENT_CATEGORIES,
  type CreateDocumentInput,
  type DocumentSortColumn,
  type DocumentSortDir,
  type UpdateDocumentInput,
} from "./documents.schemas";

// The FleetDocument aggregate service (ADR-0049 F2) — the SINGLE writer of
// fleet_document rows, which is where the exactly-one-entity invariant and
// the per-entity category matrix live (the recorded no-DB-CHECK decision).
// Bytes go through the shared ObjectStorage seam (its third consumer, the
// extension ADR-0039 c7 pre-authorized): object-first-row-second on upload,
// row-first-object-best-effort on delete, and the magic-byte sniff is
// authoritative over the client's asserted mimetype (ADR-0044 c3, via
// common/file-signatures.ts).

/** Upload ceiling (ADR-0049 c2): 10 MB, enforced BOTH by the controller's
 * multer `limits.fileSize` (rejects the stream early with 413) and re-checked
 * here (defense in depth for non-HTTP callers). Same value as the agent
 * surface's MAX_ATTACHMENT_BYTES, declared per-module on purpose — the two
 * contracts may diverge independently. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const LIST_TAKE_DEFAULT = 50;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

/** File extension per sniffed type (key-shape cosmetics only — the sniffed
 * contentType column is what serving trusts). */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** The minimal structural slice of multer's in-memory file object the upload
 * path consumes (the agent-attachments UploadedImageFile pattern). */
export interface UploadedDocumentFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

/** The three entity kinds a document may attach to, derived (never stored)
 * from whichever FK is non-null. */
export type DocumentEntityType = "VEHICLE" | "DRIVER" | "CUSTOMER";

/** A FleetDocument row plus the derived entityType the UI keys on. */
export type FleetDocumentWithEntityType = FleetDocument & { entityType: DocumentEntityType };

export interface ListResult {
  items: FleetDocumentWithEntityType[];
  total: number;
  skip: number;
  take: number;
  sortBy: DocumentSortColumn;
  sortDir: DocumentSortDir;
}

/** The per-entity category matrix (ADR-0049 c3), keyed by entity kind. */
const CATEGORY_MATRIX: Record<DocumentEntityType, readonly string[]> = {
  VEHICLE: VEHICLE_DOCUMENT_CATEGORIES,
  DRIVER: DRIVER_DOCUMENT_CATEGORIES,
  CUSTOMER: CUSTOMER_DOCUMENT_CATEGORIES,
};

/** Derive the entity kind from whichever FK is set (the single source of
 * truth — there is deliberately no stored entityType column to drift). */
export function entityTypeOf(document: {
  vehicleId: string | null;
  driverId: string | null;
  customerId: string | null;
}): DocumentEntityType {
  if (document.vehicleId !== null) return "VEHICLE";
  if (document.driverId !== null) return "DRIVER";
  return "CUSTOMER";
}

function withEntityType(document: FleetDocument): FleetDocumentWithEntityType {
  return { ...document, entityType: entityTypeOf(document) };
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Store one document against exactly one entity. The schema already
   * validated exactly-one; this re-asserts it (single-writer discipline),
   * verifies the ENTITY EXISTS (404 — a document on a ghost vehicle helps
   * nobody), enforces the category matrix (400), sniffs the bytes, and
   * writes object-first-row-second with best-effort cleanup on row failure.
   */
  async upload(
    input: CreateDocumentInput,
    file: UploadedDocumentFile,
    createdById: string,
  ): Promise<FleetDocumentWithEntityType> {
    const entity = await this.resolveEntity(input);

    if (file.buffer.length > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException("Document is larger than 10 MB.");
    }
    const contentType = sniffDocumentType(file.buffer);
    if (contentType === null) {
      throw new BadRequestException(
        "Attach a PDF, JPEG, PNG, or WEBP file (the file's content did not match any of these).",
      );
    }

    this.assertCategoryAllowed(entity.type, input.category);

    const r2Key = `documents/${entity.type.toLowerCase()}/${entity.id}/${randomUUID()}.${EXTENSION_BY_TYPE[contentType]}`;
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");

    await this.storage.put({ key: r2Key, body: file.buffer, contentType });
    try {
      const row = await this.prisma.fleetDocument.create({
        data: {
          vehicleId: input.vehicleId ?? null,
          driverId: input.driverId ?? null,
          customerId: input.customerId ?? null,
          category: input.category,
          title: input.title,
          notes: input.notes ?? null,
          expiresAt: input.expiresAt ?? null,
          r2Key,
          contentType,
          sizeBytes: file.buffer.length,
          sha256,
          createdById,
        },
      });
      return withEntityType(row);
    } catch (error) {
      // Best-effort cleanup so a failed row never strands a live object.
      await this.storage.delete(r2Key).catch(() => undefined);
      throw error;
    }
  }

  /** Entity-anchored list (exactly-one filter enforced by the schema). */
  async list({
    vehicleId,
    driverId,
    customerId,
    category,
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    vehicleId?: string;
    driverId?: string;
    customerId?: string;
    category?: DocumentCategory;
    skip?: number;
    take?: number;
    sortBy?: DocumentSortColumn;
    sortDir?: DocumentSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) ? Math.max(Math.floor(skip), 0) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    const where: Prisma.FleetDocumentWhereInput = {
      ...(vehicleId !== undefined ? { vehicleId } : {}),
      ...(driverId !== undefined ? { driverId } : {}),
      ...(customerId !== undefined ? { customerId } : {}),
      ...(category !== undefined ? { category } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.fleetDocument.findMany({
        where,
        orderBy: [{ [sortBy]: sortDir }, { id: "asc" }],
        skip: safeSkip,
        take: safeTake,
      }),
      this.prisma.fleetDocument.count({ where }),
    ]);

    return {
      items: items.map(withEntityType),
      total,
      skip: safeSkip,
      take: safeTake,
      sortBy,
      sortDir,
    };
  }

  async getById(id: string): Promise<FleetDocumentWithEntityType> {
    const document = await this.prisma.fleetDocument.findUnique({ where: { id } });
    if (document === null) {
      throw new NotFoundException(`Document ${id} not found.`);
    }
    return withEntityType(document);
  }

  /**
   * Fetch a document's bytes for the authed streaming route. A missing object
   * behind a live row is an internal inconsistency and surfaces loudly
   * (ObjectStorageObjectNotFoundError → 500) — in dev the mock store is
   * process-local, so rows from a previous API process do this by design.
   */
  async getContent(id: string): Promise<{ buffer: Buffer; contentType: string }> {
    const document = await this.getById(id);
    const buffer = await this.storage.get(document.r2Key);
    return { buffer, contentType: document.contentType };
  }

  /**
   * The F3 renewal link-check (ADR-0049 c4), exposed as the module's PUBLIC
   * interface so the vehicles module never reaches into the fleet_document
   * table: the linked "proof" document must EXIST (400 — the caller holds an
   * id the operator typed/picked, so a ghost is a bad request, not a 404 on
   * this route), belong to the SAME vehicle, and carry the expected category
   * (a BLUEBOOK renewal links a BLUEBOOK scan, never a random paper).
   */
  async assertLinkableToVehicle(
    documentId: string,
    vehicleId: string,
    expectedCategory: DocumentCategory,
  ): Promise<void> {
    const document = await this.prisma.fleetDocument.findUnique({
      where: { id: documentId },
      select: { vehicleId: true, category: true },
    });
    if (document === null) {
      throw new BadRequestException(`Document ${documentId} does not exist.`);
    }
    if (document.vehicleId !== vehicleId) {
      throw new BadRequestException(
        `Document ${documentId} is not attached to this vehicle; a renewal must link a ` +
          "document on the same vehicle.",
      );
    }
    if (document.category !== expectedCategory) {
      throw new BadRequestException(
        `Document ${documentId} is category ${document.category}; a ${expectedCategory} ` +
          `renewal must link a ${expectedCategory} document.`,
      );
    }
  }

  /** Metadata-only PATCH; the entity FKs and bytes are immutable. A category
   * change re-checks the matrix against the document's (fixed) entity. */
  async update(id: string, input: UpdateDocumentInput): Promise<FleetDocumentWithEntityType> {
    const existing = await this.getById(id);

    if (input.category !== undefined) {
      this.assertCategoryAllowed(existing.entityType, input.category);
    }

    const row = await this.prisma.fleetDocument.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      },
    });
    return withEntityType(row);
  }

  /**
   * Delete (ADMIN-only at the route — documents:delete): row-first so a
   * Restrict reference (an F3 RenewalRecord linking this paper as proof)
   * blocks with the house P2003 → 409 BEFORE any bytes are touched; then
   * best-effort object delete (a failed object delete orphans bounded bytes,
   * never a row pointing at nothing).
   */
  async delete(id: string): Promise<void> {
    const document = await this.getById(id);
    try {
      await this.prisma.fleetDocument.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
        // The house delete-blocker: a Restrict reference (an F3 RenewalRecord
        // holding this paper as proof) surfaces as 409, never a 500.
        throw new ConflictException("Cannot delete document: it is referenced by other records.");
      }
      throw error;
    }
    await this.storage.delete(document.r2Key).catch(() => undefined);
  }

  /** The matrix check, shared by upload and category-PATCH. */
  private assertCategoryAllowed(entityType: DocumentEntityType, category: string): void {
    if (!CATEGORY_MATRIX[entityType].includes(category)) {
      const allowed = CATEGORY_MATRIX[entityType].join(", ");
      throw new BadRequestException(
        `Category ${category} is not allowed on a ${entityType.toLowerCase()} document (allowed: ${allowed}).`,
      );
    }
  }

  /** Resolve which entity the exactly-one FK names, verifying it EXISTS. */
  private async resolveEntity(input: {
    vehicleId?: string;
    driverId?: string;
    customerId?: string;
  }): Promise<{ type: DocumentEntityType; id: string }> {
    const set = [input.vehicleId, input.driverId, input.customerId].filter(
      (id) => id !== undefined,
    );
    if (set.length !== 1) {
      throw new BadRequestException(
        "Exactly one of vehicleId, driverId, or customerId must be provided.",
      );
    }

    if (input.vehicleId !== undefined) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: input.vehicleId },
        select: { id: true },
      });
      if (vehicle === null) throw new NotFoundException(`Vehicle ${input.vehicleId} not found.`);
      return { type: "VEHICLE", id: vehicle.id };
    }
    if (input.driverId !== undefined) {
      const driver = await this.prisma.driver.findUnique({
        where: { id: input.driverId },
        select: { id: true },
      });
      if (driver === null) throw new NotFoundException(`Driver ${input.driverId} not found.`);
      return { type: "DRIVER", id: driver.id };
    }
    const customerId = input.customerId as string;
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (customer === null) throw new NotFoundException(`Customer ${customerId} not found.`);
    return { type: "CUSTOMER", id: customer.id };
  }
}
