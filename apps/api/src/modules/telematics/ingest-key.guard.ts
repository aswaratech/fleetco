import { timingSafeEqual } from "node:crypto";

import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";

import { env } from "../../config/env";

// The DI token the guard reads the configured key through — a provider (bound
// from the typed env in TelematicsModule) rather than a direct `env` read so
// tests can exercise the configured / unconfigured / mismatch branches by
// overriding one provider, without mutating process.env before module load.
// Same indirection pattern as the AUTH token.
export const INGEST_API_KEY_TOKEN = "telematics:ingest-api-key";

export const ingestApiKeyProvider = {
  provide: INGEST_API_KEY_TOKEN,
  useFactory: (): string | null => env.INGEST_API_KEY ?? null,
};

// IngestKeyGuard — machine auth for the Traccar gateway → API hop (ADR-0042
// c5, ticket M5). NOT a session guard: the caller is the Traccar container on
// the compose network, which cannot hold a better-auth session; it presents
// the static Tier-1 `INGEST_API_KEY` as an `X-Ingest-Key` header on every
// position forward (Traccar's `forward.header` config, injected on-box via
// CONFIG_USE_ENVIRONMENT_VARIABLES — never committed).
//
// Three branches, in fail-closed order:
//   1. Key NOT CONFIGURED → 503. An unconfigured deployment does not accept
//      gateway ingest, ever — absence of the secret must never mean open.
//      (503, not 401: the request may carry a perfectly good key; it is the
//      SERVER that is not set up, and Traccar's forwarder treats the non-2xx
//      as retryable, which is right — the operator fixing .env recovers the
//      queued forwards.)
//   2. Header missing or not a single string → 401.
//   3. Comparison via crypto.timingSafeEqual (length-guarded — a length
//      mismatch reveals only the length, the standard trade) → 401 on
//      mismatch.
//
// The key value is never logged on any branch (Tier 1; the `*.key` pino
// redact path is the backstop, not the defense).
@Injectable()
export class IngestKeyGuard implements CanActivate {
  constructor(@Inject(INGEST_API_KEY_TOKEN) private readonly configuredKey: string | null) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.configuredKey === null) {
      throw new ServiceUnavailableException("Gateway ingest is not configured.");
    }

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const presented = request.headers["x-ingest-key"];
    if (typeof presented !== "string" || presented.length === 0) {
      throw new UnauthorizedException();
    }

    const expected = Buffer.from(this.configuredKey, "utf8");
    const actual = Buffer.from(presented, "utf8");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
