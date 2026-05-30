import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import * as Sentry from "@sentry/node";
import { toNodeHandler } from "better-auth/node";

import { AppModule } from "./app.module";
import { env } from "./config/env";
import { buildOtlpSpanProcessors } from "./observability/otel";
import { AUTH } from "./modules/auth/auth.tokens";
import type { AuthInstance } from "./modules/auth/auth";

async function bootstrap(): Promise<void> {
  // Sentry/OpenTelemetry init stays at the very top of bootstrap(), before
  // NestFactory.create and above the better-auth mount: the ADR-0021
  // body-parser ordering is load-bearing and this block must not be
  // reordered into it. Sentry v9 owns the global OpenTelemetry
  // TracerProvider and auto-instruments HTTP, Prisma and Redis; we EXTEND
  // it with an env-gated OTLP span processor (ADR-0024 commitment 1) rather
  // than standing up a second NodeSDK. Init when EITHER signal is set:
  // SENTRY_DSN ships errors to Sentry, OTEL_EXPORTER_OTLP_ENDPOINT exports
  // spans to a collector, and each runs without the other — dsn: undefined
  // keeps the OpenTelemetry setup live with Sentry ingest off (commitment 6).
  if (env.SENTRY_DSN || env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      // Additional OTLP/HTTP span processor, present only when the endpoint
      // is set ([] otherwise, a no-op). Nothing is added for HTTP/Prisma/
      // Redis — Sentry's default integrations already cover them (ADR-0024
      // commitments 2 & 4).
      openTelemetrySpanProcessors: buildOtlpSpanProcessors(env.OTEL_EXPORTER_OTLP_ENDPOINT),
    });
  }

  // bodyParser:false disables Nest's automatic body parsers globally;
  // we re-attach them below for non-/auth routes. better-auth's
  // toNodeHandler reads the raw request body itself, and a body parser
  // running first would consume the stream and silently break sign-in.
  // See ADR-0021 "Consequences — Harder" for the rationale.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  // CORS must be registered BEFORE the better-auth mount below. Express runs
  // middleware in registration order; the toNodeHandler for /auth/* intercepts
  // and fully handles those requests (including OPTIONS preflight) before any
  // later middleware runs. Registering CORS here ensures the browser's
  // preflight to /auth/sign-in/email receives Access-Control-Allow-Origin.
  // CORS middleware only reads/writes headers — it never consumes the request
  // body — so moving it before better-auth does not affect the body-parser
  // ordering that ADR-0021 requires.
  app.enableCors({
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  });

  // Mount better-auth at /auth/{*splat} (Express 5 wildcard syntax).
  // Must run BEFORE the body parsers below.
  const auth = app.get<AuthInstance>(AUTH);
  app.use("/auth/{*splat}", toNodeHandler(auth));

  // Re-enable body parsing for non-/auth routes. Nest's request pipeline
  // (DTOs, ValidationPipe, controllers reading req.body) expects parsed
  // bodies. Order matters: this MUST come after the better-auth mount.
  app.useBodyParser("json");
  app.useBodyParser("urlencoded", { extended: true });

  await app.listen(env.PORT);

  const logger = app.get(Logger);
  logger.log(`FleetCo API listening on http://localhost:${env.PORT}`, "Bootstrap");
}

bootstrap().catch((error: unknown) => {
  console.error("Fatal: failed to bootstrap FleetCo API", error);
  process.exit(1);
});
