import { Resend } from "resend";

import { env } from "../../config/env";
import {
  Mailer,
  MailerNotConfiguredError,
  MailerSendError,
  type MailMessage,
  type MailerSendResult,
} from "./mailer";

// The Resend implementation of the FleetCo {@link Mailer} seam (ADR-0038
// commitment 1). This is the ONLY file in the API that imports `resend` (or
// names any email vendor): everything upstream — the C2 scan, the digest
// renderer — depends on the vendor-free `Mailer` contract, so swapping to
// Postmark, SMTP (nodemailer), or another channel later means rewriting this
// one file and nothing else (the seam guarantee, c1).

/**
 * The minimal slice of the Resend SDK that {@link ResendMailer} uses. FleetCo-
 * owned so the send mapping is unit-testable with a plain fake — the `resend`
 * import stays confined to this file, and tests never reach the network. The
 * real `Resend` instance satisfies this structurally (verified at install
 * against resend@6.14.0: `emails.send(payload) => Promise<{ data: { id } | null;
 * error: ErrorResponse | null }>`).
 */
interface ResendEmailApi {
  emails: {
    send(payload: {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html?: string;
    }): Promise<{
      data: { id: string } | null;
      error: { name: string; message: string } | null;
    }>;
  };
}

/**
 * The default sending address. PLACEHOLDER — the real address depends on a
 * verified sending domain that only exists post-deploy (ADR-0038 c9 / the
 * "most deploy-dependent feature" cost). C2's module wiring supplies the real
 * `from` without touching any caller, because `from` is channel transport
 * config and deliberately NOT part of {@link MailMessage}. Uses the reserved
 * `.example` TLD so it can never be mistaken for a real address.
 */
export const DEFAULT_FROM_ADDRESS = "FleetCo <reminders@fleetco.example>";

export class ResendMailer extends Mailer {
  private readonly client: ResendEmailApi | null;
  private readonly from: string;

  /**
   * @param opts.apiKey  Overrides `env.RESEND_API_KEY` (tests pass an explicit
   *                     value, or `undefined` to force the no-key path
   *                     deterministically regardless of ambient env). When the
   *                     `apiKey` property is omitted entirely, the typed env is
   *                     read — exactly as `RedisService` reads `REDIS_URL`.
   * @param opts.from    Overrides {@link DEFAULT_FROM_ADDRESS} (C2 wiring / tests).
   * @param opts.client  Injects a Resend-shaped client so the send mapping is
   *                     exercised in tests with no network. When omitted, a real
   *                     `Resend` is constructed iff a key is present.
   */
  constructor(opts?: { apiKey?: string; from?: string; client?: ResendEmailApi }) {
    super();
    this.from = opts?.from ?? DEFAULT_FROM_ADDRESS;

    if (opts?.client !== undefined) {
      this.client = opts.client;
      return;
    }

    // Resolve the key: an explicitly-passed `apiKey` (even `undefined`) wins, so
    // a test can force the no-key path; otherwise fall back to the typed env.
    const apiKey = opts !== undefined && "apiKey" in opts ? opts.apiKey : env.RESEND_API_KEY;

    // The Resend constructor THROWS on a missing key (verified at install), so
    // construct it ONLY when a non-empty key exists; otherwise hold null and let
    // send() surface MailerNotConfiguredError. This is what lets the app boot in
    // dev / test / CI without a key (ADR-0038 c1) — the channel only sends in
    // production, where the operator supplies the key.
    this.client = apiKey !== undefined && apiKey !== "" ? new Resend(apiKey) : null;
  }

  async send(message: MailMessage): Promise<MailerSendResult> {
    if (this.client === null) {
      throw new MailerNotConfiguredError(
        "RESEND_API_KEY is not configured; the reminder channel cannot send. It only " +
          "delivers from production with the operator-supplied key and a verified sending " +
          "domain (ADR-0038).",
      );
    }

    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    if (error !== null) {
      // Do NOT swallow — C3's `reminder_delivery` SLI counts a failed attempt by
      // this throw. Carry only the PII-free provider error category, never the
      // recipient or the provider's raw message (ADR-0013).
      throw new MailerSendError(error.name, { cause: error });
    }

    return { id: data?.id };
  }
}
