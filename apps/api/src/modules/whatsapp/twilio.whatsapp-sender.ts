import { env } from "../../config/env";
import {
  WhatsAppSender,
  WhatsAppSenderNotConfiguredError,
  WhatsAppSendError,
  type WhatsAppMessage,
  type WhatsAppSendResult,
} from "./whatsapp-sender";

// The Twilio implementation of the {@link WhatsAppSender} seam (ADR-0046 c5,
// ticket W3). This is the ONLY file in the API that names Twilio's endpoint.
// It is RAW `fetch` — zero new dependencies, the PO's explicit decision 4
// (mirroring how deepseek.client.ts talks to DeepSeek): Twilio's Messages API
// is one form-encoded POST with Basic auth, so an SDK would buy nothing.
//
// Reliability contract, deliberately SIMPLER than deepseek.client.ts:
//   • ONE attempt, NO internal retries. The W4 `whatsapp-inbound` queue's
//     job-retry policy is the retry layer (ADR-0046 c3's re-enqueue posture);
//     a sender-level retry ladder would multiply with the job retries and
//     double-send on an ambiguous timeout (the send is NOT idempotent — Twilio
//     mints a new message per POST).
//   • A per-call AbortController timeout so a hung send cannot wedge the
//     worker; a timeout is reported as its own category and never retried
//     here (see above).
//
// Tier discipline (ADR-0013 / ADR-0046 c8): TWILIO_AUTH_TOKEN is Tier-1 —
// placed ONLY in the Authorization header, never logged, never embedded in a
// thrown error. The recipient number and reply body are Tier-2 — they travel
// only in the POST form body (never the URL, which can land in proxy logs),
// and errors carry a bare category + Twilio's numeric code (the response body
// is never attached: it echoes the To number).

/** Twilio's REST API base (the Messages endpoint lives under it). */
export const TWILIO_API_BASE_URL = "https://api.twilio.com";

/** Per-send timeout. Small: the Messages API answers in well under a second,
 * and the W4 worker's turn budget should be spent on the agent, not a hung
 * send. */
export const TWILIO_SEND_TIMEOUT_MS = 15_000;

// Abort-reason sentinel so the catch can tell our timeout from a network
// failure without string matching (the deepseek.client.ts idea).
const TIMEOUT_SENTINEL = Symbol("twilio-send-timeout");

/** Prefix a bare E.164 with Twilio's `whatsapp:` transport marker; a value
 * already carrying it (TWILIO_WHATSAPP_FROM is documented in that form) passes
 * through unchanged. */
function withWhatsAppPrefix(phone: string): string {
  return phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
}

/** Best-effort extraction of Twilio's numeric error `code` from a failure
 * response — the one PII-free, operationally useful field. Everything else in
 * the body (message, more_info) can echo the To number and is dropped. */
async function readTwilioErrorCode(response: Response): Promise<number | null> {
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      typeof (parsed as { code: unknown }).code === "number"
    ) {
      return (parsed as { code: number }).code;
    }
  } catch {
    // Non-JSON error body — the status category alone will have to do.
  }
  return null;
}

export class TwilioWhatsAppSender extends WhatsAppSender {
  private readonly accountSid: string | null;
  private readonly authToken: string | null;
  private readonly from: string | null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  /**
   * @param opts.accountSid Overrides `env.TWILIO_ACCOUNT_SID` (tests pass an
   *                        explicit value, or `undefined` to force the
   *                        not-configured path regardless of ambient env — the
   *                        DeepSeekClient `"key" in opts` pattern).
   * @param opts.authToken  Overrides `env.TWILIO_AUTH_TOKEN`.
   * @param opts.from       Overrides `env.TWILIO_WHATSAPP_FROM`.
   * @param opts.baseUrl    Overrides {@link TWILIO_API_BASE_URL} (tests only).
   * @param opts.fetchFn    Injects a fetch so the wire mapping and timeout are
   *                        exercised with no network.
   * @param opts.timeoutMs  Overrides the per-send abort (tests use ~5 ms).
   */
  constructor(opts?: {
    accountSid?: string;
    authToken?: string;
    from?: string;
    baseUrl?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  }) {
    super();
    const accountSid =
      opts !== undefined && "accountSid" in opts ? opts.accountSid : env.TWILIO_ACCOUNT_SID;
    const authToken =
      opts !== undefined && "authToken" in opts ? opts.authToken : env.TWILIO_AUTH_TOKEN;
    const from = opts !== undefined && "from" in opts ? opts.from : env.TWILIO_WHATSAPP_FROM;
    this.accountSid = accountSid !== undefined && accountSid !== "" ? accountSid : null;
    this.authToken = authToken !== undefined && authToken !== "" ? authToken : null;
    this.from = from !== undefined && from !== "" ? from : null;
    this.baseUrl = opts?.baseUrl ?? TWILIO_API_BASE_URL;
    // Wrap the global fetch in an arrow so it keeps its own `this` (an unbound
    // fetch reference throws "Illegal invocation" on some runtimes).
    this.fetchFn = opts?.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts?.timeoutMs ?? TWILIO_SEND_TIMEOUT_MS;
  }

  async send(message: WhatsAppMessage): Promise<WhatsAppSendResult> {
    if (this.accountSid === null || this.authToken === null || this.from === null) {
      throw new WhatsAppSenderNotConfiguredError(
        "WhatsApp sending is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / " +
          "TWILIO_WHATSAPP_FROM unset) — the channel kill switch (ADR-0046 c5).",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(TIMEOUT_SENTINEL), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(
        `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          // The recipient and body ride the form body, never the URL.
          body: new URLSearchParams({
            To: withWhatsAppPrefix(message.to),
            From: withWhatsAppPrefix(this.from),
            Body: message.body,
          }).toString(),
          signal: controller.signal,
        },
      );
    } catch (error) {
      const timedOut = controller.signal.aborted && controller.signal.reason === TIMEOUT_SENTINEL;
      // The original error rides along as `cause` for a local stack trace on
      // network failures (never logged); a timeout is our own abort, so there
      // is nothing useful to attach.
      throw timedOut
        ? new WhatsAppSendError("timeout")
        : new WhatsAppSendError("network", null, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new WhatsAppSendError(`http_${response.status}`, await readTwilioErrorCode(response));
    }

    // Defensive parse: a 2xx without a readable sid is still an accepted send
    // (the contract keeps `sid` optional), never an error.
    let sid: string | undefined;
    try {
      const parsed: unknown = await response.json();
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "sid" in parsed &&
        typeof (parsed as { sid: unknown }).sid === "string"
      ) {
        sid = (parsed as { sid: string }).sid;
      }
    } catch {
      sid = undefined;
    }
    return { sid };
  }
}
