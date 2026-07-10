import { env } from "../../config/env";
import { MAX_ATTACHMENT_BYTES } from "../agent/agent-attachments.service";

// The Twilio media download (ADR-0046 W5 — the photo half of "text + receipt
// photos"). An inbound WhatsApp photo arrives as a MediaUrl0 on the webhook,
// pointing at Twilio's REST API; fetching it requires Basic auth
// (AccountSid:AuthToken) and answers 302 to a short-lived pre-signed S3 URL.
// One raw `fetch` with `redirect: "follow"` handles both hops: undici strips
// the Authorization header when following a CROSS-ORIGIN redirect, which is
// exactly what the S3 leg requires (a pre-signed URL 403s a request that
// re-presents Authorization) — documented behavior we rely on, not an
// accident.
//
// Two defenses beyond the transport:
//   • HOST ALLOWLIST before credentials are attached: the URL arrives inside
//     a signature-verified webhook, so it is Twilio-authenticated content —
//     but a URL is still data, and this client attaches a Tier-1 credential
//     to whatever it fetches. It therefore refuses anything that is not
//     exactly https://api.twilio.com/… (SSRF hygiene, fail closed).
//   • SIZE CAP at the attachment ceiling (10 MB, MAX_ATTACHMENT_BYTES) so an
//     oversized body is rejected here rather than buffered and bounced later.
//
// The declared content type is returned as INFORMATION ONLY — the attachments
// service magic-byte-sniffs the actual bytes (a content-type header is an
// assertion, ADR-0044 c3).
//
// Errors carry a bare PII-free category (the WhatsAppSendError posture);
// the URL (which embeds account/message SIDs) is never echoed.

/** The only host this client will present credentials to. */
export const TWILIO_MEDIA_HOST = "api.twilio.com";

/** Per-download timeout — generous for a few MB on a slow link. */
export const TWILIO_MEDIA_TIMEOUT_MS = 30_000;

const TIMEOUT_SENTINEL = Symbol("twilio-media-timeout");

export class TwilioMediaError extends Error {
  constructor(
    /** PII-free category: "not_configured" | "disallowed_url" | "timeout" |
     * "network" | "http_<status>" | "too_large". */
    readonly category: string,
    options?: { cause?: unknown },
  ) {
    super(`whatsapp media download failed: ${category}`, options);
    this.name = "TwilioMediaError";
  }
}

export class TwilioMediaClient {
  private readonly accountSid: string | null;
  private readonly authToken: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  /** Env-defaulted with explicit test overrides — the TwilioWhatsAppSender
   * constructor idiom exactly (the `"key" in opts` pattern). */
  constructor(opts?: {
    accountSid?: string;
    authToken?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
  }) {
    const accountSid =
      opts !== undefined && "accountSid" in opts ? opts.accountSid : env.TWILIO_ACCOUNT_SID;
    const authToken =
      opts !== undefined && "authToken" in opts ? opts.authToken : env.TWILIO_AUTH_TOKEN;
    this.accountSid = accountSid !== undefined && accountSid !== "" ? accountSid : null;
    this.authToken = authToken !== undefined && authToken !== "" ? authToken : null;
    this.fetchFn = opts?.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts?.timeoutMs ?? TWILIO_MEDIA_TIMEOUT_MS;
    this.maxBytes = opts?.maxBytes ?? MAX_ATTACHMENT_BYTES;
  }

  /** Download one media item. Returns the raw bytes plus the response's
   * DECLARED content type (informational — the caller sniffs). */
  async download(mediaUrl: string): Promise<{ bytes: Buffer; declaredContentType: string | null }> {
    if (this.accountSid === null || this.authToken === null) {
      throw new TwilioMediaError("not_configured");
    }

    let parsed: URL;
    try {
      parsed = new URL(mediaUrl);
    } catch (error) {
      throw new TwilioMediaError("disallowed_url", { cause: error });
    }
    if (parsed.protocol !== "https:" || parsed.host !== TWILIO_MEDIA_HOST) {
      throw new TwilioMediaError("disallowed_url");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(TIMEOUT_SENTINEL), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(parsed.toString(), {
        method: "GET",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        },
        // Twilio 302s to pre-signed S3; undici drops Authorization on the
        // cross-origin hop (see the file header).
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted && controller.signal.reason === TIMEOUT_SENTINEL;
      throw timedOut
        ? new TwilioMediaError("timeout")
        : new TwilioMediaError("network", { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new TwilioMediaError(`http_${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > this.maxBytes) {
      throw new TwilioMediaError("too_large");
    }
    return { bytes, declaredContentType: response.headers.get("content-type") };
  }
}
