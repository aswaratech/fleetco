import { execSync } from "node:child_process";

// Vitest global setup. Runs once at the start of the test run, before
// any test files are imported. We use this hook to apply Prisma
// migrations to the test database. Each test file's beforeEach then
// truncates the affected tables via test/db.ts's resetDb() — see
// ADR-0023 for the rationale on reset-between-tests over Testcontainers
// or schema-per-test.
//
// DATABASE_URL is set by vitest.config.ts's test.env block before this
// runs; it points at the fleetco_test database in local dev and at the
// services: postgres block's connection string in CI. `migrate deploy`
// (not `migrate dev`) is correct here: it applies pending migrations
// without prompting and never creates new migrations, which matches the
// "tests must not produce schema changes" expectation.
//
// The pino-pino stack imported by apps/api can be noisy during migrate;
// stdio: "inherit" surfaces real failures (e.g. test DB unreachable)
// without hiding them behind Vitest's captured output. The cost is
// migrate's own progress log appearing once per `pnpm test` invocation.
export default async function globalSetup(): Promise<void> {
  // Ensure the schema is in sync with the Prisma model before any test
  // file imports PrismaService. `migrate deploy` is idempotent — on a
  // freshly-created `fleetco_test` database it applies every migration;
  // on a re-run it is a no-op.
  execSync("pnpm exec prisma migrate deploy", {
    stdio: "inherit",
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      // Match the same DATABASE_URL the tests will use. Vitest's env
      // block is applied to test workers but the global-setup hook runs
      // in the Vitest main process, where process.env.DATABASE_URL may
      // not yet reflect the override. Re-derive it here from the same
      // fallback chain.
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://fleetco:fleetco@localhost:5432/fleetco_test?schema=public",
    },
  });
}
