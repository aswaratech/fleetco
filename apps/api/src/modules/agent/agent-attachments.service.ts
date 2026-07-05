import { createHash, randomUUID } from "node:crypto";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { type AgentAttachment } from "@prisma/client";

import { type Actor } from "../auth/driver-scope.service";

// PrismaService and ObjectStorage are injected by NestJS via
// emitDecoratorMetadata; the class references must remain value imports so
// the DI container can resolve them (the standard override).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { ObjectStorage } from "../storage/object-storage";

// Agent chat attachments (ADR-0044 c3, ticket V4): one photo per turn enters
// through here — validated (magic-byte sniff + size), stored through the
// shared ObjectStorage seam (R2 in production, in-memory mock in dev/CI), and
// rowed as agent_attachment with the claim-on-send lifecycle V7 completes.
// Everything is owner-scoped with the transcript's existence-hiding posture:
// a foreign conversation or attachment 404s, never 403s.

/** Upload ceiling (ADR-0044 c3): 10 MB, enforced BOTH by the controller's
 * multer `limits.fileSize` (rejects the stream early with 413) and re-checked
 * here (defense in depth for non-HTTP callers). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * The minimal structural slice of multer's in-memory file object the upload
 * path consumes. Typed locally (ADR-0044 c3) instead of adding @types/multer:
 * the controller's @UploadedFile() hands this through, and any object with
 * these four fields works — which is also exactly what tests construct.
 */
export interface UploadedImageFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

/** The allowlisted image types, keyed by sniffed signature (never the
 * client's asserted mimetype — a content-type header is an assertion). */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Magic-byte sniff (ADR-0044 c3): JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A
 * 0A`, WEBP `RIFF….WEBP`. Returns the DETECTED content type or null.
 * Hand-rolled (three signatures) rather than a dependency.
 */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

@Injectable()
export class AgentAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Store one image against the acting user's OWN conversation. Order is
   * object-first, row-second: a crash between the two leaves an orphaned
   * object (bounded; the R2 lifecycle belt-and-braces), never a row pointing
   * at missing bytes. On a row-create failure the object is deleted
   * best-effort before rethrowing.
   */
  async upload(
    conversationId: string,
    file: UploadedImageFile,
    actor: Actor,
  ): Promise<AgentAttachment> {
    const conversation = await this.prisma.agentConversation.findUnique({
      where: { id: conversationId },
      select: { id: true, userId: true },
    });
    if (conversation === null || conversation.userId !== actor.userId) {
      // Existence-hiding, the transcript posture: foreign = absent.
      throw new NotFoundException(`Conversation ${conversationId} not found.`);
    }

    if (file.buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException("Photo is larger than 10 MB.");
    }
    const contentType = sniffImageType(file.buffer);
    if (contentType === null) {
      throw new BadRequestException(
        "Attach a JPEG, PNG, or WEBP image (the file's content did not match any of these).",
      );
    }

    const r2Key = `agent-attachments/${conversationId}/${randomUUID()}.${EXTENSION_BY_TYPE[contentType]}`;
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");

    await this.storage.put({ key: r2Key, body: file.buffer, contentType });
    try {
      return await this.prisma.agentAttachment.create({
        data: {
          conversationId,
          userId: actor.userId,
          r2Key,
          contentType,
          sizeBytes: file.buffer.length,
          sha256,
        },
      });
    } catch (error) {
      // Best-effort cleanup so a failed row never strands a live object.
      await this.storage.delete(r2Key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Fetch an attachment's bytes for the OWNER (the authed thumbnail/full-view
   * route). Foreign or absent = 404; a missing object behind a live row is an
   * internal inconsistency and surfaces loudly (ObjectStorageObjectNotFoundError).
   */
  async getBytes(
    attachmentId: string,
    actor: Actor,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const attachment = await this.prisma.agentAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (attachment === null || attachment.userId !== actor.userId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found.`);
    }
    const buffer = await this.storage.get(attachment.r2Key);
    return { buffer, contentType: attachment.contentType };
  }

  /**
   * The claim-side validations (ADR-0044 c7), run by the turn loop BEFORE it
   * persists the user message so an unusable attachment fails the turn fast:
   * absent/foreign = 404 (existence-hiding); the wrong conversation or an
   * already-sent attachment = 400 (the caller holds a real-but-unusable id).
   */
  async assertClaimable(
    attachmentId: string,
    conversationId: string,
    actor: Actor,
  ): Promise<AgentAttachment> {
    const attachment = await this.prisma.agentAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (attachment === null || attachment.userId !== actor.userId) {
      throw new NotFoundException(`Attachment ${attachmentId} not found.`);
    }
    if (attachment.conversationId !== conversationId) {
      throw new BadRequestException("The attachment belongs to a different conversation.");
    }
    if (attachment.messageId !== null) {
      throw new BadRequestException("The attachment was already sent with an earlier message.");
    }
    return attachment;
  }

  /** Claim the attachment onto the persisted user message (pending → sent). */
  async claim(attachmentId: string, messageId: string): Promise<AgentAttachment> {
    return this.prisma.agentAttachment.update({
      where: { id: attachmentId },
      data: { messageId },
    });
  }

  /** The extraction input for a validated attachment (the turn loop's read). */
  async readBytes(attachment: AgentAttachment): Promise<{ bytes: Buffer; contentType: string }> {
    const bytes = await this.storage.get(attachment.r2Key);
    return { bytes, contentType: attachment.contentType };
  }
}
