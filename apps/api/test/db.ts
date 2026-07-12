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
  // ADR-0043 A2: the AI agent's persistence + audit spine. agent_action FKs
  // into agent_conversation + agent_message (SetNull) and user (Restrict), so
  // it precedes all three; agent_message FKs into agent_conversation
  // (Cascade); agent_conversation FKs into user. CASCADE makes order cosmetic.
  "agent_action",
  // ADR-0046 W2: the WhatsApp channel tables. agent_phone_link FKs into user
  // (Restrict) + agent_conversation (SetNull); whatsapp_message_log FKs into
  // agent_conversation + agent_message (SetNull). CASCADE makes order cosmetic;
  // listed with the agent group they extend so a per-test reset clears them.
  "agent_phone_link",
  "whatsapp_message_log",
  "agent_message",
  "agent_conversation",
  // No FK into any other table (a scan is a background job, not a user action),
  // so it truncates independently; listed first as a standalone leaf.
  "notification_log",
  // Program D (ADR-0039 c4): the gapless invoice-number counter. A standalone
  // leaf — no FK into any other table (the natural key (documentType,
  // bsFiscalYear) is its identity), so it truncates independently. Listed here
  // so the per-test reset clears any counter rows an issue test created.
  "invoice_number_sequence",
  "service_record",
  "service_schedule",
  "geofence",
  // ADR-0042 M3: FKs into vehicle + user, so it precedes both (CASCADE makes
  // order cosmetic, but the list stays readable as a dependency ordering).
  "tracker_device",
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
  // ADR-0047 W2: the Site aggregate (reusable pickup/drop-off pins). Trip FKs
  // into it (pickupSiteId/dropoffSiteId, Restrict) so it follows trip; site
  // itself FKs into user (createdById). CASCADE makes order cosmetic.
  "site",
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
