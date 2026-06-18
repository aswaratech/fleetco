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
