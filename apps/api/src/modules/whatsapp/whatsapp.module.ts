import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";

import { AgentModule } from "../agent/agent.module";
import { TwilioMediaClient } from "./twilio-media.client";
import { twilioSignatureConfigProvider, TwilioSignatureGuard } from "./twilio-signature.guard";
import { WhatsAppIdentityService } from "./whatsapp-identity.service";
import { WhatsAppInboundController } from "./whatsapp-inbound.controller";
import { WhatsAppInboundProcessor } from "./whatsapp-inbound.processor";
import { WhatsAppSender } from "./whatsapp-sender";
import { createWhatsAppSender } from "./whatsapp-sender.factory";
import { WHATSAPP_INBOUND_QUEUE } from "./whatsapp.constants";

// The WhatsApp agent channel (ADR-0046 c1) — a DEDICATED delivery module on
// the NotificationModule precedent, NOT a fold-in: it brings its own provider
// seam (WhatsAppSender), its own queue + worker, its own signature guard, and
// its own identity + ledger tables. It IMPORTS AgentModule and drives the
// existing agent through its public service interface (runTurn /
// createConversation) — a channel, not a capability: the tool registry,
// audit spine, autonomy posture, and budgets are ADR-0043's, unchanged.
//
// The WhatsAppSender binding is the W3 factory verbatim (the RESEND_API_KEY
// kill-switch idiom): TwilioWhatsAppSender only when the full TWILIO_* outbound
// group is present, the recording no-network mock everywhere else. The
// signature guard's config rides its own provider token so tests exercise the
// configured / unconfigured branches without touching process.env.
@Module({
  imports: [AgentModule, BullModule.registerQueue({ name: WHATSAPP_INBOUND_QUEUE })],
  controllers: [WhatsAppInboundController],
  providers: [
    twilioSignatureConfigProvider,
    TwilioSignatureGuard,
    WhatsAppIdentityService,
    WhatsAppInboundProcessor,
    // W5: downloads a webhook's media item (Basic-auth to api.twilio.com
    // only, host-allowlisted). Env-defaulted like the sender; while TWILIO_*
    // is unset it throws not_configured — unreachable in practice, since the
    // unconfigured guard 503s every webhook before a media job can exist.
    TwilioMediaClient,
    {
      provide: WhatsAppSender,
      useFactory: (): WhatsAppSender => createWhatsAppSender(),
    },
  ],
})
export class WhatsAppModule {}
