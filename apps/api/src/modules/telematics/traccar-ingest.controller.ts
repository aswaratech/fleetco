import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { IngestKeyGuard } from "./ingest-key.guard";
import { TraccarForwardSchema, type TraccarForward } from "./traccar-ingest.schemas";

// TraccarIngestService is injected via emitDecoratorMetadata; value import for
// DI, same pattern as every controller.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { TraccarIngestService, type TraccarIngestAck } from "./traccar-ingest.service";

// Machine-ingest controller for the Traccar gateway (ADR-0042 c4/c5, M5).
// Deliberately its OWN controller, NOT a route on TelematicsController: the
// caller is a machine on the compose network, so the guard chain is
// IngestKeyGuard ALONE — no AuthGuard (no session exists to resolve), no
// RolesGuard (no role exists to check). Keeping the session-authenticated
// chain and the machine chain on separate controllers means neither can
// accidentally inherit the other's posture.
//
// While INGEST_API_KEY is unset the guard answers 503 (fails closed — see
// ingest-key.guard.ts), so this surface simply does not exist on a box that
// has not been configured for a gateway.
@Controller("api/v1/telematics/ingest")
@UseGuards(IngestKeyGuard)
export class TraccarIngestController {
  constructor(private readonly traccarIngest: TraccarIngestService) {}

  /**
   * One Traccar position forward (forward.type=json posts ONE position per
   * request). Always 202 on a validated payload — accepted-and-enqueued or
   * accepted-and-dropped (unknown IMEI / invalid fix / out-of-bounds values;
   * the ack carries the drop reason) — because a non-2xx makes Traccar retry,
   * and retrying cannot fix any of those. A payload that fails even the
   * TOLERANT TraccarForwardSchema (no coordinates, no fixTime, no device id)
   * is a 400 from the pipe: that is not a position at all, and surfacing a
   * malformed forwarder config loudly in Traccar's log beats silently eating
   * everything it sends.
   */
  @Post("traccar")
  @HttpCode(HttpStatus.ACCEPTED)
  async ingestTraccar(
    @Body(new ZodValidationPipe(TraccarForwardSchema)) body: TraccarForward,
  ): Promise<TraccarIngestAck> {
    return this.traccarIngest.ingestForward(body);
  }
}
