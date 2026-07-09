import { env } from "../../config/env";
import { MockWhatsAppSender } from "./mock.whatsapp-sender";
import { TwilioWhatsAppSender } from "./twilio.whatsapp-sender";
import type { WhatsAppSender } from "./whatsapp-sender";

// The WhatsAppSender selection (ADR-0046 c5) — the NotificationModule Mailer
// useFactory, extracted to a named function because the module that consumes it
// lands in W4 (the W3/W4 ticket boundary). W4 wires
// `{ provide: WhatsAppSender, useFactory: createWhatsAppSender }` verbatim.
//
// The real sender binds ONLY when the full TWILIO_* outbound group is present
// (accountSid + authToken + from); everywhere else (dev / test / CI, or the
// operator clearing the values — the kill switch) the no-network mock binds, so
// the API never reaches Twilio outside a deliberately configured deployment —
// the RESEND_API_KEY idiom. TWILIO_WEBHOOK_URL is NOT part of this check: it
// gates the INBOUND signature guard (W4), not outbound sending.

/** The three env values the outbound channel needs. Split out so tests can
 * exercise the selection without mutating the frozen typed env. */
export interface WhatsAppSenderConfig {
  accountSid: string | undefined;
  authToken: string | undefined;
  from: string | undefined;
}

export function createWhatsAppSender(config?: WhatsAppSenderConfig): WhatsAppSender {
  const cfg = config ?? {
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_WHATSAPP_FROM,
  };
  const configured =
    cfg.accountSid !== undefined &&
    cfg.accountSid !== "" &&
    cfg.authToken !== undefined &&
    cfg.authToken !== "" &&
    cfg.from !== undefined &&
    cfg.from !== "";
  return configured
    ? new TwilioWhatsAppSender({
        accountSid: cfg.accountSid,
        authToken: cfg.authToken,
        from: cfg.from,
      })
    : new MockWhatsAppSender();
}
