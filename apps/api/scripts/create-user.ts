// Idempotent office-staff / admin / driver account creator (ADR-0028 c8, ADR-0034).
//
// ADR-0028 makes `role` a better-auth `additionalFields` field with
// `input: false`, so a role can NEVER be set through the public sign-up /
// profile-update API — the single most important privilege-escalation defense
// (c8). The consequence for account creation: `auth.api.signUpEmail` always
// produces a user at the least-privilege OFFICE_STAFF default, and the
// requested role is then set by a direct, privileged server-side Prisma write.
// This script is that privileged path — the stated mechanism (c8) for creating
// office-staff (and the occasional additional ADMIN) account. There is
// deliberately NO public users-management HTTP endpoint; a `users:manage` API
// is a later slice.
//
// It mirrors the seed-admin.ts discipline: idempotent (check-existing-by-email
// first), and the one Tier-1 input — the password — is read from the validated
// env (CREATE_USER_PASSWORD) so it never lands in argv / `ps` / shell history.
// The non-sensitive identifiers (email, role) are positional CLI args because,
// unlike the single founder admin seed-admin creates, this script creates many
// different accounts over time and editing .env per hire would be absurd.
//
//   Usage (pass the password inline so it is not persisted to .env):
//     CREATE_USER_PASSWORD='<temp password>' \
//       pnpm --filter @fleetco/api exec tsx scripts/create-user.ts <email> [ADMIN|OFFICE_STAFF|DRIVER]
//
//   The role argument is OPTIONAL and defaults to OFFICE_STAFF — least
//   privilege by default (c8). ADMIN is granted only by passing it explicitly.
//   DRIVER is now accepted (ADR-0034, the driver-app auth slice): it creates the
//   login identity a driver signs in with on the mobile app. DRIVER carries NO
//   gated capabilities yet — it is inert until D2 grants its own-record-scoped
//   permissions; linking the login to a Driver row (Driver.userId) is a separate
//   step the row-scoping slice needs, not this script.
//
// Tier 1 (CREATE_USER_PASSWORD, BETTER_AUTH_SECRET) is never written to any log
// channel. The created account's email (Tier 2) is echoed to stdout only so the
// operator can confirm what was created on their machine.

import { fileURLToPath } from "node:url";

import { PrismaClient, UserRole } from "@prisma/client";

import { env } from "../src/config/env";
import { createAuth } from "../src/modules/auth/auth";

export interface CreateUserInput {
  email: string;
  password: string;
  role: UserRole;
  name?: string;
}

export interface CreateUserResult {
  created: boolean;
  id: string;
  email: string;
  role: UserRole;
}

// Create a user at `role`, idempotently. The role is set by a direct Prisma
// write AFTER signUpEmail because `input: false` blocks it through the public
// API (ADR-0028 c8). Idempotent on email: the FIRST run creates the account at
// the requested role; a subsequent run with the same email is a no-op that
// reports the existing account's CURRENT role and never mutates it — a role
// change is a deliberate, separate privileged action, not a side effect of
// re-running creation. The two writes are ordered signUp-then-elevate, so a
// crash between them leaves the user at the OFFICE_STAFF default (under-
// privileged — the safe direction), never silently elevated.
export async function createUser(
  prisma: PrismaClient,
  input: CreateUserInput,
): Promise<CreateUserResult> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, role: true },
  });
  if (existing) {
    return { created: false, id: existing.id, email: input.email, role: existing.role };
  }

  const auth = createAuth(prisma);
  const signUp = await auth.api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name ?? input.email.split("@")[0] ?? "user",
    },
  });

  // input:false means signUpEmail ignored any role and applied the OFFICE_STAFF
  // default; set the requested role with a privileged direct write (c8).
  const updated = await prisma.user.update({
    where: { id: signUp.user.id },
    data: { role: input.role },
    select: { id: true, email: true, role: true },
  });
  return { created: true, id: updated.id, email: updated.email, role: updated.role };
}

// Parse the optional positional role argument into a UserRole. Omitted -> the
// least-privilege OFFICE_STAFF default (c8); ADMIN and DRIVER must be requested
// explicitly (DRIVER is the driver-app login role, ADR-0034). Pure (no I/O) so
// the policy is unit-testable without a database; main() lets a thrown error
// surface as a usage message.
export function parseRoleArg(roleArg: string | undefined): UserRole {
  if (roleArg === undefined) return UserRole.OFFICE_STAFF;
  if (
    roleArg === UserRole.ADMIN ||
    roleArg === UserRole.OFFICE_STAFF ||
    roleArg === UserRole.DRIVER
  ) {
    return roleArg;
  }
  throw new Error(
    `Invalid role "${roleArg}". This script creates ADMIN, OFFICE_STAFF, or DRIVER ` +
      `accounts; omit the role argument for the least-privilege OFFICE_STAFF default.`,
  );
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    throw new Error(
      "Usage: CREATE_USER_PASSWORD='<password>' tsx scripts/create-user.ts <email> [ADMIN|OFFICE_STAFF|DRIVER]",
    );
  }
  if (!env.CREATE_USER_PASSWORD) {
    throw new Error(
      "CREATE_USER_PASSWORD must be set (a Tier-1 credential; pass it inline so it is not persisted to .env).",
    );
  }
  const role = parseRoleArg(process.argv[3]);

  const prisma = new PrismaClient();
  try {
    const result = await createUser(prisma, {
      email,
      password: env.CREATE_USER_PASSWORD,
      role,
    });
    if (result.created) {
      console.log(`Created ${result.role} user ${result.email} (id=${result.id}).`);
    } else {
      console.log(
        `User ${result.email} already exists (id=${result.id}, role=${result.role}); no change.`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Run main() ONLY when executed directly (tsx scripts/create-user.ts ...), not
// when imported by a test. The test imports `createUser` / `parseRoleArg` and
// must not trigger the argv-reading, process-exiting CLI path.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
