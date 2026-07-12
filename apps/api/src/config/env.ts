import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load apps/api/.env into process.env before validation. Required vars
// (DATABASE_URL, REDIS_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL) have no
// defaults, so the .env file must be in place when this module is first
// imported (which happens before NestJS's ConfigModule.forRoot() runs).
// Silently does nothing if .env is absent, which is correct for
// production (env vars come from the platform's secret store, not a file).
loadDotenv();

// dotenv preserves empty values as "" (rather than undefined). For
// optional-URL fields we want "" to mean "not set" so .env.example's
// `SENTRY_DSN=` line does not trip URL validation.
const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.length === 0 ? undefined : value;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  SENTRY_DSN: z.preprocess(emptyStringAsUndefined, z.string().url().optional()),
  // OpenTelemetry OTLP/HTTP traces endpoint (ADR-0024). Optional URL,
  // empty-string -> undefined, mirroring SENTRY_DSN exactly. When unset
  // (the Phase-1 default) no OTLP exporter is built and the API ships no
  // OTLP telemetry; when set, spans fan out to both Sentry and this
  // collector. Value is the full traces URL (e.g.
  // https://collector.example.com/v1/traces), not the OTel-base endpoint.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyStringAsUndefined, z.string().url().optional()),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // better-auth wiring (ADR-0015, ADR-0021).
  // BETTER_AUTH_SECRET is Tier 1 per ADR-0013 — never appears in any committed file.
  // Min length 32 bytes (256 bits) per better-auth's recommendation.
  BETTER_AUTH_SECRET: z.string().min(32),
  // The API's public base URL. better-auth uses this for cookie domain
  // calculation and origin checks. In dev: http://localhost:3001 (or the
  // overridden PORT). In production: the deploy-ADR-named host.
  BETTER_AUTH_URL: z.string().url(),
  // Comma-separated allowlist of origins that may post credentials to the API.
  // Used by NestJS app.enableCors({ origin, credentials: true }) AND by
  // better-auth's trustedOrigins so the two stay in sync.
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // Admin-seed inputs. Optional at API runtime — only the seed-admin
  // script enforces their presence at run time. Validated separately
  // there so a missing ADMIN_EMAIL does not block API boot.
  // ADMIN_EMAIL is Tier 2 PII per ADR-0013.
  // ADMIN_PASSWORD is Tier 1 per ADR-0013 (the founder's credential).
  ADMIN_EMAIL: z.preprocess(emptyStringAsUndefined, z.string().email().optional()),
  ADMIN_PASSWORD: z.preprocess(emptyStringAsUndefined, z.string().min(8).optional()),

  // create-user.ts input (ADR-0028 c8 — the office-staff / admin creation path).
  // Optional at API runtime — only the create-user script reads it, and only
  // when run; its absence never blocks API boot. A Tier 1 credential per
  // ADR-0013 (the password for a newly-created office-staff / ADMIN account),
  // so it never appears in any committed file and is passed inline on the
  // command (not stored in .env) so it does not land in argv / `ps` / shell
  // history. Min length 8 mirrors ADMIN_PASSWORD and better-auth's own minimum.
  CREATE_USER_PASSWORD: z.preprocess(emptyStringAsUndefined, z.string().min(8).optional()),

  // Transactional-email provider API key (ADR-0038 commitment 1/9 — the
  // notification/reminder-delivery channel, Program C). Read here through the
  // typed env exactly as REDIS_URL is, and consumed only by ResendMailer
  // (apps/api/src/modules/notifications/resend.mailer.ts).
  //
  // Tier 1 secret per ADR-0013: it lives ONLY in the production secret store
  // (ADR-0014), is NEVER committed to any file, and is NEVER logged — loaded
  // via this config, never string-concatenated into a log line (the `*.secret`
  // / `*.token` pino redact paths are the backstop; the primary defense is that
  // ResendMailer never logs it). OPTIONAL so the app still boots without it in
  // dev / test / CI: the reminder channel only delivers from production, where
  // the operator supplies the key and a verified sending domain. When unset,
  // ResendMailer tolerates construction but throws a clear error if a real send
  // is attempted (so a misconfigured prod surfaces loudly, while dev/test/CI
  // never reach the network). Empty-string -> undefined, like SENTRY_DSN.
  RESEND_API_KEY: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // Optional comma-separated recipient override for the reminder digest
  // (ADR-0038 commitment 7). When set, these addresses are added to the v1
  // recipients (the ADMIN users' emails) — the escape hatch for a shared inbox
  // or a non-user address. Parsed (split/trim/dedup) in NotificationService;
  // empty-string -> undefined, like CORS_ORIGIN's sibling optional vars. The
  // addresses are Tier-2 PII (ADR-0013) but, like ADMIN_EMAIL, never logged.
  NOTIFICATION_RECIPIENTS: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // FleetCo's OWN supplier PAN/VAT number for invoicing (ADR-0039 commitment 9).
  // This is the SELLER's tax identity printed on every tax invoice — DISTINCT
  // from the buyer's Customer.panNumber. It is an OPERATOR-SUPPLIED settings
  // value, empty until the operator fills it (exactly like RESEND_API_KEY and
  // the future R2 creds), and is NEVER hardcoded to a fabricated PAN. The
  // invoice issue flow (D3) treats it as a documented precondition: issuing is
  // refused with a clear error until this is set, so a real tax invoice can
  // never go out without FleetCo's own registration.
  //
  // ⚠️ PROPOSED / operator-supplied — the supplier PAN and the full IRD-required
  // invoice field set remain operator/accountant-verify before real billing
  // (ADR-0039 c9). Tier-3 business config per ADR-0013. Empty-string ->
  // undefined, like SENTRY_DSN's siblings, so a blank line in .env means "not
  // set" rather than an empty PAN.
  INVOICE_SUPPLIER_PAN: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // FleetCo's OWN supplier NAME for the invoice header (ADR-0039 c9). The seller
  // name printed beside the supplier PAN. Operator-supplied but, unlike the PAN,
  // it has a safe default ("FleetCo" — the company this software serves per
  // CLAUDE.md, not a fabrication) so a missing name never blocks issue; only the
  // PAN is a hard precondition. Tier-3 business config. Empty-string -> undefined.
  INVOICE_SUPPLIER_NAME: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // Cloudflare R2 object-storage config for the invoice PDF (ADR-0039 commitment
  // 7 — the FIRST in-app R2 use; ADR-0014 c6 deferred in-app R2 uploads to Phase
  // 2). All four are OPERATOR-SUPPLIED and empty until the operator fills them
  // (exactly like RESEND_API_KEY / INVOICE_SUPPLIER_PAN): when any is unset the
  // module wires the no-network MockObjectStorage and invoice issue() refuses with
  // a clear 422 (the same precondition posture as the supplier PAN), so the API
  // never reaches R2 outside production. All read through the typed env exactly as
  // REDIS_URL is, and consumed ONLY by R2ObjectStorage (r2.object-storage.ts).
  // Empty-string -> undefined, like SENTRY_DSN's siblings.
  //
  // R2_ENDPOINT (the S3 API endpoint, e.g. https://<accountid>.r2.cloudflarestorage.com)
  // and R2_BUCKET are Tier-3 config. R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are
  // Tier 1 secrets per ADR-0013: they live ONLY in the production secret store
  // (ADR-0014), are NEVER committed to any file, and are NEVER logged (the
  // `*.secret` / `*.token` / `*.key` pino redact paths backstop; the primary
  // defense is that R2ObjectStorage never logs them). NEVER hardcode a credential.
  R2_ENDPOINT: z.preprocess(emptyStringAsUndefined, z.string().url().optional()),
  R2_ACCESS_KEY_ID: z.preprocess(emptyStringAsUndefined, z.string().optional()),
  R2_SECRET_ACCESS_KEY: z.preprocess(emptyStringAsUndefined, z.string().optional()),
  R2_BUCKET: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // Machine-ingest credential for the Traccar gateway → API hop (ADR-0042 c5,
  // ticket M5). A static shared secret the gateway sends as an `X-Ingest-Key`
  // header on every position forward; IngestKeyGuard compares it with
  // crypto.timingSafeEqual and FAILS CLOSED — while this is unset the
  // /telematics/ingest/* route answers 503, never open. Min 32 chars when set
  // (mirrors BETTER_AUTH_SECRET's floor; generate with `openssl rand -hex 32`).
  //
  // Tier 1 secret per ADR-0013: lives ONLY in the on-box .env (ADR-0014), never
  // committed, never logged (the `*.key` pino redact path backstops; the guard
  // never logs it). OPTIONAL so dev/test/CI boot without it — there is no
  // gateway outside production. Chosen over a machine user + bearer session
  // (ADR-0042 c5): better-auth 1.6.11 has no api-key plugin, bearer tokens
  // expire and would need a stored password + re-login state machine, and the
  // hop is compose-network-internal (this key is defense-in-depth, not the
  // only wall). Empty-string -> undefined, like SENTRY_DSN.
  INGEST_API_KEY: z.preprocess(emptyStringAsUndefined, z.string().min(32).optional()),

  // DeepSeek hosted-LLM API key for the AI chat agent (ADR-0043 commitment 2).
  // Read here through the typed env exactly as RESEND_API_KEY is, and consumed
  // only by the agent module's LLM-client factory (A3).
  //
  // Tier 1 secret per ADR-0013: it lives ONLY in the production secret store
  // (ADR-0014), is NEVER committed to any file, and is NEVER logged (the
  // `*.key` / `*.secret` pino redact paths are the backstop; the primary
  // defense is that DeepSeekClient never logs it). OPTIONAL so the app boots
  // without it in dev / test / CI: when unset the DI factory binds
  // MockLlmClient everywhere, so dev/CI never touch the network — and
  // UNSETTING the key in production is the agent's kill switch (ADR-0043 c2:
  // "unsetting the key is the production kill switch"). Empty-string ->
  // undefined, like SENTRY_DSN.
  DEEPSEEK_API_KEY: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // The DeepSeek model name the agent requests (ADR-0043 c2 — env-configurable
  // so a model swap is an env edit, not a deploy). Tier-4 config, defaulted
  // like CORS_ORIGIN. deepseek-v4-flash is the day-one target; the legacy
  // deepseek-chat / deepseek-reasoner names deprecate 2026-07-24 per the
  // provider's published schedule (verified 2026-07-02 in ADR-0043).
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-flash"),

  // The SELF-HOSTED OCR sidecar's OpenAI-compatible base URL (ADR-0044 Box B:
  // document images are processed on FleetCo infrastructure and never egress
  // as pixels) — e.g. http://localhost:12434/engines/llama.cpp/v1 under
  // Docker Model Runner locally, or the production sidecar's URL on the box.
  // Tier-4 config (an internal URL, no secret material — the sidecar lives on
  // the private network). OPTIONAL, and the feature's kill switch (the
  // DEEPSEEK_API_KEY pattern): unset ⇒ the DI factory binds
  // MockVisionExtractor (configured=false) ⇒ attachment turns degrade to an
  // honest "extraction is not configured" notice; nothing is extracted.
  AGENT_OCR_URL: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // The OCR model id requested from the sidecar. Tier-4 config, defaulted to
  // the community GGUF quantization the V0 eval pinned (digest recorded in
  // ADR-0044 Box B; self-quantizing from the official weights is the recorded
  // production preference — swapping is an env edit, not a deploy).
  AGENT_OCR_MODEL: z.string().default("huggingface.co/sahilchachra/unlimited-ocr-gguf:Q4_K_M"),

  // Twilio WhatsApp channel credentials (ADR-0046 — the WhatsApp agent channel
  // over the ADR-0043 chat agent). All OPTIONAL and unset by default: when the
  // TWILIO_* group is absent the DI factory binds MockWhatsAppSender and the
  // TwilioSignatureGuard FAILS CLOSED (503), so the channel is OFF — the
  // RESEND_API_KEY / DEEPSEEK_API_KEY kill-switch idiom. Read through the typed
  // env exactly as those are; consumed only by the whatsapp module (W3/W4).
  // Production values are operator-supplied and live only on the box (ADR-0014),
  // never committed.
  //
  // TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are Tier-1 secrets per ADR-0013 (the
  // auth token both verifies the inbound X-Twilio-Signature AND Basic-auths the
  // outbound send). Never logged — loaded via this config, never string-
  // concatenated into a log line (`*.token` / `*.secret` pino redact paths
  // backstop; the guard/sender never log them). Empty-string -> undefined.
  TWILIO_ACCOUNT_SID: z.preprocess(emptyStringAsUndefined, z.string().optional()),
  TWILIO_AUTH_TOKEN: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // The WhatsApp-enabled Twilio sender the outbound reply is sent From, in
  // Twilio's `whatsapp:+<E164>` form (the sandbox default is
  // whatsapp:+14155238886). Tier-4 config (a public number, no secret
  // material). Empty-string -> undefined.
  TWILIO_WHATSAPP_FROM: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // The canonical PUBLIC URL Twilio calls for the inbound webhook, e.g.
  // https://<deploy-host>/api/v1/whatsapp/inbound. TwilioSignatureGuard verifies
  // the signature against THIS constant, never a URL reconstructed from request
  // headers (behind Caddy the app sees http://api:3001, which would never match;
  // request-controlled headers must not enter a security decision — ADR-0046 c2).
  // The guard fails closed (503) when this OR TWILIO_AUTH_TOKEN is unset. Tier-4
  // config (a public URL). Empty-string -> undefined.
  TWILIO_WEBHOOK_URL: z.preprocess(emptyStringAsUndefined, z.string().url().optional()),

  // The admin web app's public base URL, used to build ABSOLUTE deep-links in
  // agent replies (ADR-0046 c6 — a WhatsApp reply's action cards link to the
  // affected record, and a relative link is useless in a text message).
  // BETTER_AUTH_URL is the API host (the wrong target), so this is distinct.
  // Tier-4 config. OPTIONAL: when unset the renderer omits the deep-link. In
  // production the operator sets the deploy host; in local dev set
  // http://localhost:3000. Empty-string -> undefined.
  WEB_PUBLIC_URL: z.preprocess(emptyStringAsUndefined, z.string().url().optional()),

  // Routing-provider selection for the in-app route-preview line + ETA on the
  // admin dispatch map (ADR-0047 c9 — the RoutingProvider seam). UNSET / "mock"
  // (the dev / test / CI default) binds the no-network MockRoutingProvider: a
  // deterministic haversine estimate with ZERO coordinate egress, so the build
  // stays green with no key. Setting a LIVE provider name (e.g. "google" for
  // Google Directions' live-traffic ETA, or "osrm" for a self-hosted free-flow
  // router) is M1-GATED ACTIVATION — the live impl is NOT built in this program,
  // so a selected-but-unbuilt provider binds a stub that fails loudly on use
  // (LiveRoutingProviderStub) rather than silently returning a Mock estimate.
  // Tier-4 config, defaulted-by-absence like DEEPSEEK_MODEL. Empty-string ->
  // undefined, like SENTRY_DSN.
  ROUTING_PROVIDER: z.preprocess(emptyStringAsUndefined, z.string().optional()),

  // The LIVE routing provider's API key (ADR-0047 c9 — a Google Directions/Routes
  // billing key, or a self-hosted router's token). Tier-1 secret per ADR-0013: it
  // lives ONLY in the production secret store (ADR-0014), is NEVER committed to
  // any file, and is NEVER logged — the routing module makes no logger calls, so
  // the key never enters a log line and never rides a log object as a field.
  // OPTIONAL and UNUSED until the operator activates a live ROUTING_PROVIDER at M1
  // — the Mock needs no key and makes zero egress. Empty-string -> undefined, like
  // DEEPSEEK_API_KEY.
  ROUTING_API_KEY: z.preprocess(emptyStringAsUndefined, z.string().optional()),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.format());
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = parseEnv();
