// Idempotent founder-admin seeder. Reads ADMIN_EMAIL + ADMIN_PASSWORD from
// apps/api/.env (loaded by env.ts at import time) and creates the single
// founder ADMIN if it does not yet exist. Used in dev-setup.md and by the
// first-deploy checklist (docs/runbook/deploy.md step 11 — `db:seed` on the box).
//
// Role mechanics (ADR-0028 c8): `role` is a better-auth additionalField with
// `input: false`, so signUpEmail ALWAYS produces the least-privilege
// OFFICE_STAFF default and ADMIN must be set by a direct, privileged Prisma
// write afterwards. This seeder delegates to createUser (scripts/create-user.ts),
// the one shared implementation of that signUp-then-elevate sequence. It
// previously called signUpEmail alone, which left the founder account at
// OFFICE_STAFF — caught empirically by the 2026-07-10 local deploy dry-run:
// a fresh `db:seed` on the production stack produced a founder with no ADMIN
// capability (no users:manage, no agent:use, no invoices:write), while every
// smoke check still passed.
//
// Idempotent on email: a re-run never mutates the existing row (a role change
// is a deliberate manual action, mirroring create-user.ts) — but it REPORTS
// the current role loudly so a mis-roled founder is visible, not silent.
//
// Tier 1 (ADMIN_PASSWORD, BETTER_AUTH_SECRET) is never written to any log
// channel. ADMIN_EMAIL (Tier 2) is echoed to stdout only so the operator can
// confirm which admin was created on their machine.

import { fileURLToPath } from "node:url";

import { PrismaClient, UserRole } from "@prisma/client";

import { env } from "../src/config/env";
import { createUser, type CreateUserResult } from "./create-user";

// Create (or report) the founder ADMIN. Thin, testable wrapper over createUser
// pinned to role ADMIN — the seed path must never mint anything less
// privileged (deploy.md step 11 assumes the seeded account can operate the
// whole admin surface, users:manage and agent:use included).
export async function seedAdmin(
  prisma: PrismaClient,
  input: { email: string; password: string },
): Promise<CreateUserResult> {
  return createUser(prisma, {
    email: input.email,
    password: input.password,
    role: UserRole.ADMIN,
  });
}

async function main(): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.error(
      "ADMIN_EMAIL and ADMIN_PASSWORD must be set in apps/api/.env before running the seed.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const result = await seedAdmin(prisma, {
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    });
    if (result.created) {
      console.log(`Created admin ${result.email} (id=${result.id}, role=${result.role}).`);
    } else if (result.role === UserRole.ADMIN) {
      console.log(`Admin ${result.email} already exists (id=${result.id}).`);
    } else {
      console.warn(
        `WARNING: ${result.email} already exists with role=${result.role}, NOT ADMIN. ` +
          `The seed never mutates an existing account — repair the role via a deliberate ` +
          `privileged action (see the role notes in scripts/create-user.ts).`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Run main() ONLY when executed directly (tsx scripts/seed-admin.ts), not when
// imported by a test. The test imports `seedAdmin` and must not trigger the
// env-reading, process-exiting CLI path.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
