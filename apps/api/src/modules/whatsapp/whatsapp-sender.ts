// The FleetCo-owned WhatsApp-sending seam (ADR-0046 commitment 5) — the Mailer
// seam rotated to WhatsApp. This is the ONE place the rest of the API talks to
// "sending a WhatsApp message": the W4 inbound processor depends only on this
// `WhatsAppSender` contract and the `WhatsAppMessage` shape — never on Twilio.
// The concrete provider is named in exactly one implementation file,
// `twilio.whatsapp-sender.ts`, so the ADR's named fallback (Meta Cloud API
// direct, §Alternatives) is a sibling file swap and nothing that calls
// `WhatsAppSender.send` changes.
//
// WHY AN ABSTRACT CLASS, NOT A BARE `interface`: same reason as `Mailer` —
// NestJS resolves providers by a runtime token and an interface does not exist
// at runtime. The W4 module wires `{ provide: WhatsAppSender, useFactory: … }`
// (see whatsapp-sender.factory.ts) and the processor injects
// `constructor(private readonly sender: WhatsAppSender)`.

/**
 * A single outbound WhatsApp message handed to a {@link WhatsAppSender}. The
 * shape ADR-0046 c5 fixes: a recipient and a plain-text body (WhatsApp replies
 * are text — the c6 renderer produces the body; there is no HTML channel).
 *
 * `to` is the recipient's phone in canonical E.164 (the resolver/link key form,
 * WITHOUT the `whatsapp:` transport prefix — prefixing is a Twilio wire detail
 * the implementation owns). Tier-2 PII (ADR-0013): implementations must never
 * log it and never embed it in a thrown error message. `body` embeds Tier-2/3
 * fleet data (ADR-0046 c8) and is handled the same way.
 */
export interface WhatsAppMessage {
  /** Recipient phone, canonical E.164 (no `whatsapp:` prefix). Tier-2 PII. */
  to: string;
  /** The plain-text reply body (already rendered + chunked ≤ 1600 chars). */
  body: string;
}

/**
 * The result of an accepted send. `sid` is Twilio's message SID when the
 * provider returns one; kept optional so a future provider that returns no id
 * still satisfies the contract. The W4 processor records it on the
 * `WhatsAppMessageLog` row as the delivery receipt (the
 * `NotificationLog.providerMessageId` posture).
 */
export interface WhatsAppSendResult {
  /** The provider's message SID, when available. */
  sid?: string;
}

/**
 * The WhatsApp-sending port. One method. The W4 processor depends on this —
 * not on any vendor. See the file header for why this is an abstract class.
 */
export abstract class WhatsAppSender {
  /**
   * Send one message. Resolves with the provider's result on accept; REJECTS
   * (never swallows) on failure — the W4 queue's job-retry policy is the retry
   * layer, so implementations make exactly ONE attempt and throw
   * {@link WhatsAppSenderNotConfiguredError} when no provider credential is
   * configured, or {@link WhatsAppSendError} when the provider rejects the
   * send.
   */
  abstract send(message: WhatsAppMessage): Promise<WhatsAppSendResult>;
}

/**
 * Thrown by a {@link WhatsAppSender} when a real send is attempted but the
 * channel has no provider credential configured (the `TWILIO_*` group unset —
 * the kill switch, ADR-0046 c5). Construction is tolerated without credentials
 * so the app boots; an actual send surfaces a clear, loud error rather than
 * silently no-op'ing or reaching the network — the `MailerNotConfiguredError`
 * posture exactly. In production the credentials are present, so this never
 * fires there.
 */
export class WhatsAppSenderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppSenderNotConfiguredError";
  }
}

/**
 * Thrown by a {@link WhatsAppSender} when the provider rejects a send. The
 * message carries only a PII-free CATEGORY ("timeout" | "network" |
 * "http_<status>") plus Twilio's numeric error code when one was returned —
 * NEVER the recipient number or the reply body, which are Tier-2 (ADR-0013 /
 * ADR-0046 c8); the provider's response body is never attached either (it can
 * echo the To number). The original error is attached as `cause` for a local
 * stack trace on network failures and is never logged.
 */
export class WhatsAppSendError extends Error {
  constructor(
    /** The PII-free failure category ("timeout" | "network" | "http_<status>"). */
    readonly category: string,
    /** Twilio's numeric error code (e.g. 63007), when the response carried one. */
    readonly twilioCode: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(
      `whatsapp send failed: ${category}${twilioCode !== null ? ` (twilio code ${twilioCode})` : ""}`,
      options,
    );
    this.name = "WhatsAppSendError";
  }
}
