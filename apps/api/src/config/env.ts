import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load apps/api/.env into process.env before validation. Required vars
// (DATABASE_URL, REDIS_URL) have no defaults, so the .env file must be
// in place when this module is first imported (which happens before
// NestJS's ConfigModule.forRoot() runs). Silently does nothing if .env
// is absent, which is correct for production (env vars come from the
// platform's secret store, not a file).
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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
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
