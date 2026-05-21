// Idempotent admin seeder. Reads ADMIN_EMAIL + ADMIN_PASSWORD from
// apps/api/.env (loaded by env.ts at import time) and creates the
// single admin user if it does not yet exist. Used in dev-setup.md
// (and the eventual deploy ADR when production seeding is named).
//
// Tier 1 (ADMIN_PASSWORD, BETTER_AUTH_SECRET) is never written to
// any log channel. ADMIN_EMAIL (Tier 2) is echoed to stdout only so
// the operator can confirm which admin was created on their machine.

import { PrismaClient } from "@prisma/client";

import { env } from "../src/config/env";
import { createAuth } from "../src/modules/auth/auth";

async function main(): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.error(
      "ADMIN_EMAIL and ADMIN_PASSWORD must be set in apps/api/.env before running the seed.",
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({
      where: { email: env.ADMIN_EMAIL },
      select: { id: true },
    });

    if (existing) {
      console.log(`Admin ${env.ADMIN_EMAIL} already exists (id=${existing.id}).`);
      return;
    }

    const auth = createAuth(prisma);
    const result = await auth.api.signUpEmail({
      body: {
        email: env.ADMIN_EMAIL,
        password: env.ADMIN_PASSWORD,
        name: env.ADMIN_EMAIL.split("@")[0] ?? "admin",
      },
    });

    console.log(`Created admin ${env.ADMIN_EMAIL} (id=${result.user.id}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
