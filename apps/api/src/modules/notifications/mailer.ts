// The FleetCo-owned mail-sending seam (ADR-0038 commitment 1). This is the ONE
// place the rest of the API talks to "sending an email": the reminder scan and
// the digest renderer (Program C, ticket C2+) depend only on this `Mailer`
// contract and the `MailMessage` shape — never on a vendor SDK. The concrete
// provider (Resend today, per ADR-0038 c1's recommendation) is named in exactly
// one implementation file, `resend.mailer.ts`, so a later swap to Postmark, SMTP
// (nodemailer), or any other channel changes that one file and nothing that
// calls `Mailer.send`. This mirrors how `apps/web/src/lib/nepali-date.ts` wraps
// `nepali-date-converter` and `apps/api/src/common/wkt.ts` centralizes the WKT
// builder: own the seam, isolate the dependency.
//
// WHY AN ABSTRACT CLASS, NOT A BARE `interface`: NestJS resolves providers by a
// runtime token, and a TypeScript `interface` does not exist at runtime. An
// abstract class is BOTH the compile-time contract AND a runtime DI token, so
// C2 can wire `{ provide: Mailer, useClass: ResendMailer }` (or `MockMailer` in
// dev/test/CI) and inject `constructor(private readonly mailer: Mailer)`. This
// is the idiomatic NestJS "inject by interface" pattern — not a new
// architectural pattern. (The web wrappers above are plain functions because
// they are imported directly, not DI-resolved; a swappable channel needs the
// token.) C1 defines the contract and its implementations; the module wiring
// that provides this token lands in C2.

/**
 * A single outbound message handed to a {@link Mailer}. The shape ADR-0038
 * commitment 1 fixes: recipients, a subject, a mandatory plain-text body, and an
 * optional HTML body. The C2 digest renderer is a pure function producing
 * `{ subject, text, html }`; the scan supplies `to`.
 *
 * `to` is Tier-2 PII — a recipient email address (ADR-0013) — and is ALREADY
 * covered by the pino `*.email` redact path. Implementations must never log it,
 * and must never embed it in a thrown error message (see {@link MailerSendError}).
 */
export interface MailMessage {
  /** One or more recipient addresses. Tier-2 PII (ADR-0013). */
  to: string[];
  /** The subject line (DESIGN.md §Voice: state the fact — no exclamation). */
  subject: string;
  /** The mandatory plain-text body (ADR-0038 c7: text required, HTML optional). */
  text: string;
  /** The optional HTML body. */
  html?: string;
}

/**
 * The result of a successful send. `id` is the provider's message id when it
 * returns one (Resend does); kept optional so a future channel that returns no
 * id (e.g. a fire-and-forget SMTP relay) still satisfies the contract. C2's scan
 * may record it on the `NotificationLog` as the delivery receipt.
 */
export interface MailerSendResult {
  /** The provider's message id, when available. */
  id?: string;
}

/**
 * The mail-sending port. One method. The reminder channel depends on this — not
 * on any vendor. See the file header for why this is an abstract class.
 */
export abstract class Mailer {
  /**
   * Send one message. Resolves with the provider's result on accept; REJECTS
   * (never swallows) on failure, so the C3 `reminder_delivery` SLI can count a
   * failed attempt by the thrown error. Implementations throw
   * {@link MailerNotConfiguredError} when no provider credential is configured,
   * and {@link MailerSendError} when the provider rejects the send.
   */
  abstract send(message: MailMessage): Promise<MailerSendResult>;
}

/**
 * Thrown by a {@link Mailer} when a real send is attempted but the channel has
 * no provider credential configured (e.g. `RESEND_API_KEY` unset). This is the
 * dev/test/CI guard ADR-0038 c1 calls for: construction is tolerated without a
 * key so the app boots, but an actual send surfaces a clear, loud error rather
 * than silently no-op'ing or reaching the network. In production the key is
 * always present, so this never fires there.
 */
export class MailerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailerNotConfiguredError";
  }
}

/**
 * Thrown by a {@link Mailer} when the provider rejects a send. The message
 * carries only the provider's error CATEGORY (e.g. "validation_error",
 * "rate_limit_exceeded") — NEVER the recipient address or the provider's raw
 * message, which can echo input (Tier-2 PII per ADR-0013). C3's SLI logs the
 * exception CLASS NAME only (`error_kind`), never `err.message`; keeping the
 * message PII-free is defense in depth. The original provider error is attached
 * as `cause` for a local stack trace and is never logged.
 */
export class MailerSendError extends Error {
  constructor(
    /** The provider's error category/name (PII-free). */
    readonly providerErrorName: string,
    options?: { cause?: unknown },
  ) {
    super(`mail send failed: ${providerErrorName}`, options);
    this.name = "MailerSendError";
  }
}
