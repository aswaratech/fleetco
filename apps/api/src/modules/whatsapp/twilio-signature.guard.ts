import { createHmac, timingSafeEqual } from "node:crypto";

import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";

import { env } from "../../config/env";

// TwilioSignatureGuard — machine auth for the Twilio → API webhook hop
// (ADR-0046 c2): the IngestKeyGuard posture, Twilio-adapted. NOT a session
// guard: the caller is Twilio's webhook infrastructure, which authenticates by
// signing every POST with the account's auth token. Zero-dependency by the
// PO's decision 4 — the recipe is small, fully documented, and pinned to
// Twilio's published test vector (see computeTwilioSignature).
//
// Three branches, in fail-closed order (the IngestKeyGuard shape):
//   1. AUTH TOKEN or WEBHOOK URL not configured → 503. An unconfigured
//      deployment does not accept webhooks, ever — absence of the secret must
//      never mean open. (503, not 403: the SERVER is not set up; Twilio treats
//      the non-2xx as a delivery failure and retries, which is right — the
//      operator fixing .env recovers the redelivery.)
//   2. `X-Twilio-Signature` header missing or not a single string → 403.
//   3. Recomputed signature vs presented, via length-guarded
//      crypto.timingSafeEqual → 403 on mismatch.
//
// The signature is verified against the CONFIGURED canonical webhook URL
// (`TWILIO_WEBHOOK_URL`), NEVER a URL reconstructed from `Host` /
// `X-Forwarded-*`: behind Caddy the app sees http://api:3001 (which would
// never match what Twilio signed), and request-controlled headers must not
// enter a security decision (ADR-0046 c2 — the official SDK's validateRequest
// takes the same configured URL, so this is not a zero-dep workaround).
//
// LIMIT, stated honestly (ADR-0046 §Context): a Twilio signature carries no
// timestamp or nonce, so this guard is AUTHENTICATION only — a captured POST
// verifies forever. The replay defense is the processor's dedup-by-MessageSid
// against WhatsAppMessageLog's @unique (ADR-0046 c7), not this guard.

// The DI token the guard reads its config through — a provider (bound from the
// typed env below) rather than a direct `env` read, so tests exercise the
// configured / unconfigured / mismatch branches by overriding one provider
// without mutating process.env before module load (the INGEST_API_KEY_TOKEN
// pattern).
export const TWILIO_SIGNATURE_CONFIG = "whatsapp:twilio-signature-config";

export interface TwilioSignatureConfig {
  /** Tier-1 (ADR-0013): signs the comparison; never logged, never thrown. */
  authToken: string | null;
  /** The canonical public webhook URL Twilio signed against (Tier-4). */
  webhookUrl: string | null;
}

export const twilioSignatureConfigProvider = {
  provide: TWILIO_SIGNATURE_CONFIG,
  useFactory: (): TwilioSignatureConfig => ({
    authToken: env.TWILIO_AUTH_TOKEN ?? null,
    webhookUrl: env.TWILIO_WEBHOOK_URL ?? null,
  }),
};

/**
 * Twilio's documented request-signing recipe: concatenate the canonical URL
 * with every POST parameter as `key + value`, keys sorted ascending, then
 * `base64(HMAC-SHA1(authToken, that string))`. Exported pure so the unit test
 * pins it to Twilio's PUBLISHED test vector (auth token "12345", the docs'
 * example URL + params → `0/KCTR6DLpKmkAf8muzZqo1nDgQ=`) — an external truth,
 * not this file agreeing with itself.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  constructor(@Inject(TWILIO_SIGNATURE_CONFIG) private readonly config: TwilioSignatureConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.authToken === null || this.config.webhookUrl === null) {
      throw new ServiceUnavailableException("The WhatsApp webhook is not configured.");
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      body?: Record<string, unknown>;
    }>();

    const presented = request.headers["x-twilio-signature"];
    if (typeof presented !== "string" || presented.length === 0) {
      throw new ForbiddenException();
    }

    // The signature covers EVERY posted parameter (Twilio posts
    // application/x-www-form-urlencoded; the urlencoded body parser has already
    // run — middleware precedes guards). Only string values participate: Twilio
    // sends flat string params, and anything else (a crafted nested key the
    // extended parser turned into an object) simply fails the comparison —
    // fail closed.
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.body ?? {})) {
      if (typeof value === "string") {
        params[key] = value;
      }
    }

    const expected = Buffer.from(
      computeTwilioSignature(this.config.authToken, this.config.webhookUrl, params),
      "utf8",
    );
    const actual = Buffer.from(presented, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
