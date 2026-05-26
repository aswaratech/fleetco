import { config as loadDotenv } from "dotenv";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Vitest configuration for apps/api. See ADR-0023 for the framework
// choice (Vitest vs Jest) and the database strategy (reset-between-tests
// against a real Postgres). This config wires four things:
//
//   1. unplugin-swc — NestJS relies on TypeScript's emitDecoratorMetadata
//      to drive its DI container at runtime (see ADR-0021 §6's AuthGuard
//      and apps/api/tsconfig.json's experimentalDecorators+emitDecorator-
//      Metadata pair). Vitest's default esbuild transformer does not
//      emit decorator metadata, so @Injectable() providers would fail to
//      resolve at test time. SWC's transform plugin emits the metadata
//      Nest needs.
//
//   2. test.env — apps/api/src/config/env.ts validates the environment
//      at import time with `process.exit(1)` on failure. Tests must
//      therefore have a complete, valid env BEFORE any module under
//      test is imported. We load `.env.test` here (if present) so the
//      developer can set DATABASE_URL/REDIS_URL ports that match their
//      docker-compose override (this machine's repo-root .env bumps
//      POSTGRES_PORT to 55432). The hard-coded fallbacks at the bottom
//      of test.env match the .env.example defaults — useful in CI,
//      where the workflow's `services: postgres` block matches those
//      defaults exactly. See `.env.test.example` for the copy-and-edit
//      template.
//
//   3. globalSetup — apps/api/test/global-setup.ts runs once per test
//      run; it applies `prisma migrate deploy` to the test database so
//      every test starts against an up-to-date schema. Per-test cleanup
//      (TRUNCATE) lives in apps/api/test/db.ts and is called from each
//      integration test file's beforeEach.
//
//   4. fileParallelism: false — integration tests share the test
//      database and reset it per-test; running test files in parallel
//      would race on the truncate. The ADR-0023 "Revisit when" section
//      names lock-contention scale as the signal to introduce
//      parallelism.

// Load apps/api/.env.test if it exists. dotenv silently no-ops if the
// file is absent, which is correct for CI (the workflow sets env vars
// directly on the test step). dotenv's default `override: false` means
// pre-existing process.env values (e.g., shell-exported DATABASE_URL,
// or CI's injected env) win — the local file is the fallback, not the
// override.
loadDotenv({ path: new URL(".env.test", import.meta.url) });

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: "es2022",
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    // Match the project-wide ~30s pre-commit budget; if a test exceeds
    // 30s the framework's reset-between-tests model is the wrong fit
    // for that test and the ADR-0023 "Revisit when" cases apply.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // process.env now reflects the merge of (a) the inherited shell
      // env and (b) .env.test if it existed (loaded above). The
      // fallback chain below picks the first non-empty value:
      // shell override -> .env.test -> hard-coded CI-matching default.
      NODE_ENV: "test",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://fleetco:fleetco@localhost:5432/fleetco_test?schema=public",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "test-secret-32-bytes-minimum-aaaaaa",
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
      CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:3000",
      LOG_LEVEL: "fatal",
    },
  },
});
