import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { DocumentCategory } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

// DocumentsService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern every other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  DocumentsService,
  MAX_DOCUMENT_BYTES,
  type FleetDocumentWithEntityType,
  type ListResult,
  type UploadedDocumentFile,
} from "./documents.service";
import {
  CreateDocumentSchema,
  ListDocumentsQuerySchema,
  UpdateDocumentSchema,
  type CreateDocumentInput,
  type ListDocumentsQuery,
  type UpdateDocumentInput,
} from "./documents.schemas";

// FleetDocument feature controller (ADR-0049 F2). Route prefix
// `api/v1/documents` matches the versioning convention of every other
// controller. Guards are applied at the CONTROLLER level (AuthGuard +
// RolesGuard), with the per-route capability split carrying the program's
// privilege design (c6): reading and writing documents is operational floor
// work (ADMIN + OFFICE_STAFF), while DELETE — irreversible destruction of
// compliance evidence bytes — is ADMIN-only via documents:delete. DRIVER
// holds none of the three tokens (403 everywhere here).
@Controller("api/v1/documents")
@UseGuards(AuthGuard, RolesGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * Upload one document (multipart: a `file` part + string fields validated
   * by CreateDocumentSchema). Multer keeps bytes in memory and rejects
   * streams past 10 MB with 413 before they buffer; the service then sniffs
   * magic bytes (PDF/JPEG/PNG/WEBP — the client's content type is never
   * trusted), verifies the target entity exists, enforces the per-entity
   * category matrix, and stores object-first-row-second.
   */
  @Post()
  @RequirePermission("documents:write")
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_DOCUMENT_BYTES } }))
  async upload(
    @Body(new ZodValidationPipe(CreateDocumentSchema)) body: CreateDocumentInput,
    @UploadedFile() file: UploadedDocumentFile | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<FleetDocumentWithEntityType> {
    if (file === undefined) {
      throw new BadRequestException('A multipart file part named "file" is required.');
    }
    return this.documents.upload(body, file, request.session.user.id);
  }

  /** Entity-anchored list (exactly one of vehicleId/driverId/customerId). */
  @Get()
  @RequirePermission("documents:read")
  async list(
    @Query(new ZodValidationPipe(ListDocumentsQuerySchema)) query: ListDocumentsQuery,
  ): Promise<ListResult> {
    return this.documents.list({
      ...query,
      category: query.category as DocumentCategory | undefined,
    });
  }

  /** Metadata read (the row, never the bytes — those stream below). */
  @Get(":id")
  @RequirePermission("documents:read")
  async getById(@Param("id") id: string): Promise<FleetDocumentWithEntityType> {
    return this.documents.getById(id);
  }

  /**
   * Stream the stored bytes inline with the SNIFFED content type (Tier-2
   * handling: the web reaches this only through its cookie-forwarding proxy
   * route; document bytes never get a public URL). No filename/content-
   * disposition header derived from the operator-entered title — the agent
   * attachments route's header-injection posture.
   */
  @Get(":id/content")
  @RequirePermission("documents:read")
  async getContent(@Param("id") id: string): Promise<StreamableFile> {
    const { buffer, contentType } = await this.documents.getContent(id);
    return new StreamableFile(buffer, { type: contentType, disposition: "inline" });
  }

  /** Metadata-only PATCH (title/notes/expiry/category); FKs + bytes immutable. */
  @Patch(":id")
  @RequirePermission("documents:write")
  async update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateDocumentSchema)) body: UpdateDocumentInput,
  ): Promise<FleetDocumentWithEntityType> {
    return this.documents.update(id, body);
  }

  /** ADMIN-only delete (documents:delete — the c6 evidence-destruction gate). */
  @Delete(":id")
  @RequirePermission("documents:delete")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param("id") id: string): Promise<void> {
    await this.documents.delete(id);
  }
}
