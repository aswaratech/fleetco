import { InjectQueue } from "@nestjs/bullmq";
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import type { Queue } from "bullmq";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TwilioSignatureGuard } from "./twilio-signature.guard";
import { TwilioInboundWebhookSchema, type TwilioInboundWebhook } from "./whatsapp.schemas";
import {
  WHATSAPP_INBOUND_ATTEMPTS,
  WHATSAPP_INBOUND_BACKOFF_DELAY_MS,
  WHATSAPP_INBOUND_JOB_NAME,
  WHATSAPP_INBOUND_QUEUE,
} from "./whatsapp.constants";

// Machine-ingest controller for the Twilio WhatsApp webhook (ADR-0046 c2) —
// the TraccarIngestController posture exactly: its OWN controller with the
// signature guard ALONE (no AuthGuard — no session exists to resolve; no
// RolesGuard — the human's authorization is resolved at TURN time by the
// worker, ADR-0046 c9B). While TWILIO_AUTH_TOKEN / TWILIO_WEBHOOK_URL are
// unset the guard answers 503 (fails closed), so this surface simply does not
// exist on a box that has not been configured for the channel.
//
// The handler is a pure boundary adapter: validate the loose boundary shape,
// enqueue, 202. There is deliberately no synchronous service call — the turn
// takes 10–90 s and Twilio's webhook timeout is ~15 s, so ALL work happens in
// the worker (ADR-0046 c3); the queue IS the seam this controller feeds, the
// same relationship TelematicsService.enqueue has to its controller.
@Controller("api/v1/whatsapp")
@UseGuards(TwilioSignatureGuard)
export class WhatsAppInboundController {
  constructor(
    @InjectQueue(WHATSAPP_INBOUND_QUEUE)
    private readonly queue: Queue,
  ) {}

  /**
   * One inbound message webhook. Always 202 on a validated payload —
   * accepted-and-enqueued; every judgment call (unmapped number, opt-out
   * keyword, rate cap, the turn itself) happens in the worker as an AUDITED
   * outcome, because a non-2xx here makes Twilio re-deliver and redelivery
   * cannot fix any of those. The retry envelope on the job exists for exactly
   * one case: the agent's same-conversation 409 (see whatsapp.constants.ts).
   */
  @Post("inbound")
  @HttpCode(HttpStatus.ACCEPTED)
  async inbound(
    @Body(new ZodValidationPipe(TwilioInboundWebhookSchema)) body: TwilioInboundWebhook,
  ): Promise<void> {
    await this.queue.add(
      WHATSAPP_INBOUND_JOB_NAME,
      { messageSid: body.MessageSid, from: body.From, body: body.Body },
      {
        attempts: WHATSAPP_INBOUND_ATTEMPTS,
        backoff: { type: "exponential", delay: WHATSAPP_INBOUND_BACKOFF_DELAY_MS },
      },
    );
  }
}
