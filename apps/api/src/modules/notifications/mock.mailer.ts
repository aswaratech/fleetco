import { Mailer, type MailMessage, type MailerSendResult } from "./mailer";

/**
 * An in-memory, no-network {@link Mailer} — the "test / no-op path" of ADR-0038
 * commitment 1. It never imports a vendor SDK and never opens a socket, so it
 * has two roles:
 *
 *   1. The dev / test / CI default that C2's module can wire when no provider
 *      key is configured, so the API never reaches the network outside
 *      production (the channel only delivers in prod).
 *   2. A test double: it RECORDS every message in {@link sent} (assert against
 *      it), and can be configured to throw (so C3 can exercise the
 *      `reminder_delivery` SLI's failure path) or to return a specific result.
 */
export class MockMailer extends Mailer {
  /** Every message passed to {@link send}, in call order. Assert against this. */
  readonly sent: MailMessage[] = [];

  /**
   * @param behavior.throwError If set, {@link send} records the call and then
   *                            rejects with it — exercise the failure path with
   *                            no network.
   * @param behavior.result     The result {@link send} resolves with on success
   *                            (default `{ id: "mock-<n>" }`, n = call number).
   */
  constructor(private readonly behavior: { throwError?: Error; result?: MailerSendResult } = {}) {
    super();
  }

  send(message: MailMessage): Promise<MailerSendResult> {
    this.sent.push(message);
    if (this.behavior.throwError !== undefined) {
      return Promise.reject(this.behavior.throwError);
    }
    return Promise.resolve(this.behavior.result ?? { id: `mock-${this.sent.length}` });
  }
}
