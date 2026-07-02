// Idempotent seed for the CREDENTIAL-LESS gateway system user (ADR-0042 c5,
// ticket M5).
//
// GpsPing.createdById is a required FK (ADR-0021's audit chain), but the
// Traccar gateway is a machine, not a session — its forwards are stamped with
// this system user's id (GATEWAY_USER_ID, a fixed constant shared with the
// adapter so the two can never disagree). The user deliberately gets NO
// better-auth account row: better-auth authenticates against the `account`
// table (password hash) / OAuth rows, so a bare `user` row without one CANNOT
// sign in through any auth flow. It exists purely to satisfy the FK and to
// make gateway-ingested pings attributable at a glance.
//
// Role rationale (recorded because a future reader WILL ask): the row carries
// OFFICE_STAFF — but the role is INERT for this user. It can never hold a
// session (no account row), and the ingest path that stamps its id runs
// behind IngestKeyGuard, which never consults roles. DRIVER would be wrong
// despite being "least privilege": post-D2, DRIVER carries own-record
// row-scope semantics through a Driver.userId link this user will never have,
// and a future reader seeing role=DRIVER would reasonably (and wrongly)
// expect one. OFFICE_STAFF states "a non-admin operational principal" without
// implying driver semantics.
//
//   Usage (once per environment, before the Traccar container first forwards):
//     pnpm --filter @fleetco/api exec tsx scripts/seed-gateway-user.ts
//
// Mirrors the create-user.ts / seed-admin.ts discipline: idempotent
// (find-by-id first), direct privileged Prisma write, importable by tests
// without triggering the CLI path.

import { fileURLToPath } from "node:url";

import { PrismaClient, UserRole } from "@prisma/client";

import { GATEWAY_USER_ID } from "../src/modules/telematics/traccar-ingest.service";

export const GATEWAY_USER_EMAIL = "gps-gateway@fleetco.internal";

export async function seedGatewayUser(
  prisma: PrismaClient,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.user.findUnique({ where: { id: GATEWAY_USER_ID } });
  if (existing) {
    return { id: existing.id, created: false };
  }
  // User.id has no @default in the schema, so the explicit constant id is
  // required — which is exactly what makes the adapter's stamp deterministic.
  const created = await prisma.user.create({
    data: {
      id: GATEWAY_USER_ID,
      email: GATEWAY_USER_EMAIL,
      name: "GPS gateway (system)",
      emailVerified: false,
      role: UserRole.OFFICE_STAFF,
    },
  });
  return { id: created.id, created: true };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await seedGatewayUser(prisma);
    console.log(
      result.created
        ? `Gateway system user created (id=${result.id}). It has no account row and cannot sign in.`
        : `Gateway system user already exists (id=${result.id}); no change.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Run main() ONLY when executed directly, not when imported by a test.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
