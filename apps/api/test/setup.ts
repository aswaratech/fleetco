// Per-test-file setup. Runs after Vitest's env injection from
// vitest.config.ts but before each test file is imported.
//
// Today this file is minimal: reflect-metadata is required by NestJS's
// DI container (the same dependency apps/api/src/main.ts pulls in via
// @nestjs/core) and must be imported once before any @Injectable() or
// @Module() class is loaded. Vitest hoists setupFiles' imports before
// the module-under-test, so importing it here guarantees the polyfill
// is in place even for files that test classes directly without going
// through main.ts.
//
// Future per-file hooks (e.g., resetting Sentry's global state between
// files, clearing a process-wide cache) belong here. Per-test cleanup
// (TRUNCATE) lives in test/db.ts and is called from each integration
// test file's beforeEach.
import "reflect-metadata";
