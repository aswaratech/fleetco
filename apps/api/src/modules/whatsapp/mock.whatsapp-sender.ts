import { WhatsAppSender, type WhatsAppMessage, type WhatsAppSendResult } from "./whatsapp-sender";

/**
 * An in-memory, no-network {@link WhatsAppSender} — the `MockMailer` of
 * ADR-0046 c5. It never names the vendor and never opens a socket, so it has
 * two roles:
 *
 *   1. The dev / test / CI default the W4 factory binds when the `TWILIO_*`
 *      group is absent (the kill switch), so the API never reaches Twilio
 *      outside a deliberately configured deployment.
 *   2. A test double: it RECORDS every message in {@link sent} (assert against
 *      it), and can be configured to throw (so the W4 processor's send-failure
 *      path is exercisable with no network) or to return a specific result.
 */
export class MockWhatsAppSender extends WhatsAppSender {
  /** Every message passed to {@link send}, in call order. Assert against this. */
  readonly sent: WhatsAppMessage[] = [];

  /**
   * @param behavior.throwError If set, {@link send} records the call and then
   *                            rejects with it — exercise the failure path with
   *                            no network.
   * @param behavior.result     The result {@link send} resolves with on success
   *                            (default `{ sid: "mock-<n>" }`, n = call number).
   */
  constructor(private readonly behavior: { throwError?: Error; result?: WhatsAppSendResult } = {}) {
    super();
  }

  send(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    this.sent.push(message);
    if (this.behavior.throwError !== undefined) {
      return Promise.reject(this.behavior.throwError);
    }
    return Promise.resolve(this.behavior.result ?? { sid: `mock-${this.sent.length}` });
  }
}
