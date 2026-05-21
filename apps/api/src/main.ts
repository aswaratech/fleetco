import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Logger } from "nestjs-pino";
import * as Sentry from "@sentry/node";
import { toNodeHandler } from "better-auth/node";

import { AppModule } from "./app.module";
import { env } from "./config/env";
import { AUTH } from "./modules/auth/auth.tokens";
import type { AuthInstance } from "./modules/auth/auth";

async function bootstrap(): Promise<void> {
  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
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

  // Mount better-auth at /auth/{*splat} (Express 5 wildcard syntax).
  // Must run BEFORE the body parsers below.
  const auth = app.get<AuthInstance>(AUTH);
  app.use("/auth/{*splat}", toNodeHandler(auth));

  // Re-enable body parsing for non-/auth routes. Nest's request pipeline
  // (DTOs, ValidationPipe, controllers reading req.body) expects parsed
  // bodies. Order matters: this MUST come after the better-auth mount.
  app.useBodyParser("json");
  app.useBodyParser("urlencoded", { extended: true });

  // CORS for the cross-port apps/web dev server. credentials:true is
  // required for cookies to flow; wildcard origin is forbidden by the
  // browser when credentials are sent, so we enumerate explicitly from
  // CORS_ORIGIN (which mirrors better-auth's trustedOrigins).
  app.enableCors({
    origin: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  });

  await app.listen(env.PORT);

  const logger = app.get(Logger);
  logger.log(`FleetCo API listening on http://localhost:${env.PORT}`, "Bootstrap");
}

bootstrap().catch((error: unknown) => {
  console.error("Fatal: failed to bootstrap FleetCo API", error);
  process.exit(1);
});
