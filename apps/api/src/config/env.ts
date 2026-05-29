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
