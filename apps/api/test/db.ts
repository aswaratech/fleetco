import { PrismaClient } from "@prisma/client";

// Shared test-database helpers. See ADR-0023 for the strategy choice
// (reset-between-tests against a real Postgres).
//
// resetDb() truncates the tables tests write to, RESTART IDENTITY
// CASCADE so:
//   - any sequences are reset (we use cuid()s today, but a future int
//     id would otherwise drift between test runs);
//   - foreign-key dependents are emptied along with their parents (a
//     plain TRUNCATE on `user` would fail if vehicles reference users
//     via createdById).
//
// The table list is kept in sync with apps/api/prisma/schema.prisma.
// When a future slice adds a table, its @@map name is added here. The
// truncate runs in one statement so the operation is atomic and fast
// (~5ms locally). Tests that touch tables outside this list will see
// inter-test contamination — the failure mode is loud (next test sees
// rows it did not create) and the fix is to add the table here.
//
// The @@map names from schema.prisma (snake_case) are used, not the
// Prisma model names (PascalCase), because the truncate runs at the
// SQL level via $executeRawUnsafe and operates on physical table names.
// Order is purely for human-grep-ability: tables with FKs into other
// tables come first so a reader sees the dependency direction at a
// glance (trip → driver/vehicle → user; session/account/verification →
// user). The actual TRUNCATE uses CASCADE so order has no effect on
// correctness.
const TABLES = [
  // No FK into any other table (a scan is a background job, not a user action),
  // so it truncates independently; listed first as a standalone leaf.
  "notification_log",
  "service_record",
  "service_schedule",
  "geofence",
  "gps_ping",
  "fuel_log",
  // Program D (ADR-0039): the Invoice aggregate. invoice_line is the owned child
  // (FK -> invoice CASCADE, + nullable trip/job provenance FKs) so it precedes
  // invoice; invoice FKs into customer/job/user (and itself, the credit-note
  // self-FK), so both precede those tables. CASCADE makes order cosmetic.
  "invoice_line",
  "invoice",
  "job",
  "trip",
  "driver",
  "vehicle",
  "customer",
  "session",
  "account",
  "verification",
  "user",
] as const;

export async function resetDb(prisma: PrismaClient): Promise<void> {
  // Quote each table name so Postgres treats it case-sensitively and a
  // future table whose name happens to be a SQL keyword (e.g. "user" —
  // which we already have) still works. The list is built statically
  // from the constant above, so there is no SQL injection surface.
  const tableList = TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`);
}

// Convenience wrapper for tests that need a one-off PrismaClient
// outside the NestJS TestingModule (rare; usually the test gets the
// real PrismaService via the module). The caller is responsible for
// calling `await prisma.$disconnect()` in afterAll.
export function makeTestPrisma(): PrismaClient {
  return new PrismaClient();
}
