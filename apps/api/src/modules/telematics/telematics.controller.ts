import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";
import type { AuthenticatedRequest } from "../auth/auth.types";

import { IngestBatchSchema, type IngestBatchInput } from "./telematics.schemas";

// TelematicsService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime. Same pattern every other
// controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TelematicsService } from "./telematics.service";

// 202 Accepted acknowledgement (ADR-0029 commitment 10): the write is async,
// so the body does NOT echo the rows (they do not exist yet). It returns the
// count accepted and the BullMQ job id for correlation — both safe,
// non-location values.
export interface IngestAck {
  accepted: number;
  jobId: string | null;
}

// Telematics feature controller (ADR-0029 commitment 2). The route prefix
// `api/v1/telematics` matches the versioning convention of every other
// controller.
//
// Guards are applied at the CONTROLLER level — `@UseGuards(AuthGuard,
// RolesGuard)` in that order, so AuthGuard resolves the session first (401 for
// anonymous) and RolesGuard then enforces the per-route `@RequirePermission`
// (403 for authenticated-but-unauthorized). Controller-level placement is
// forward-compatible with T5: the raw/derived READ routes added there declare
// their own `@RequirePermission("gps:read-raw" / "gps:read-derived")` and
// inherit the same composed chain without re-decorating.
@Controller("api/v1/telematics")
@UseGuards(AuthGuard, RolesGuard)
export class TelematicsController {
  constructor(private readonly telematics: TelematicsService) {}

  /**
   * Authenticated batch ingestion (ADR-0029 commitment 10). Accepts
   * `{ pings: [ ... ] }` (a single ping is the batch-of-one), validates
   * minimally via ZodValidationPipe (coordinate ranges, cuid ids, ISO
   * timestamp, `.strict()` unknown-key rejection → HTTP 400), enqueues onto
   * `gps-ingest`, and RETURNS FAST with 202 — it does NOT block on the
   * database write (the worker bulk-inserts asynchronously).
   *
   * Gated by `@RequirePermission("gps:ingest")` (ADMIN-held today, ADR-0029
   * commitment 11) on top of the composed AuthGuard + RolesGuard chain.
   *
   * `createdById` is taken from `request.session.user.id` (ADR-0021) and
   * travels in the job payload — it is NEVER read from the body, which the
   * schema's `.strict()` rejects.
   */
  @Post("pings")
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission("gps:ingest")
  async ingest(
    @Body(new ZodValidationPipe(IngestBatchSchema)) body: IngestBatchInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<IngestAck> {
    const { jobId, accepted } = await this.telematics.enqueueBatch(
      body.pings,
      request.session.user.id,
    );
    return { accepted, jobId };
  }
}
