import { randomUUID } from "node:crypto";

import { Test, type TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createUser } from "../scripts/create-user";
import { seedAdmin } from "../scripts/seed-admin";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Tests for the founder-admin seed path (deploy.md step 11's `db:seed`).
// The load-bearing assertion: the seeded founder's DB row is ADMIN. `role` is
// `input: false` (ADR-0028 c8), so signUpEmail alone yields the OFFICE_STAFF
// default — an ADMIN row proves the privileged post-signUp write ran. The
// 2026-07-10 local deploy dry-run caught the seed minting an OFFICE_STAFF
// founder on a fresh production stack precisely because this pin did not
// exist; it exists so that bug class stays dead.

describe("seedAdmin (integration, real Postgres + better-auth)", () => {
  let module: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  test("seeds the founder as ADMIN in the database (not the OFFICE_STAFF signup default)", async () => {
    const email = `founder-${randomUUID()}@fleetco.test`;
    const result = await seedAdmin(prisma, { email, password: "test-password-123" });

    expect(result.created).toBe(true);
    expect(result.role).toBe(UserRole.ADMIN);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe(UserRole.ADMIN);
  });

  test("is idempotent — a second run reports the existing founder and never mutates the row", async () => {
    const email = `founder-${randomUUID()}@fleetco.test`;
    const first = await seedAdmin(prisma, { email, password: "test-password-123" });
    const second = await seedAdmin(prisma, { email, password: "test-password-123" });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.role).toBe(UserRole.ADMIN);
    expect(await prisma.user.count()).toBe(1);
  });

  test("reports (never repairs) a pre-existing mis-roled account under the seed email", async () => {
    // A box that ran the pre-fix seed holds an OFFICE_STAFF founder; the seed
    // must surface that state, never silently escalate an existing row (the
    // create-user.ts idempotency principle).
    const email = `legacy-${randomUUID()}@fleetco.test`;
    await createUser(prisma, {
      email,
      password: "test-password-123",
      role: UserRole.OFFICE_STAFF,
    });

    const result = await seedAdmin(prisma, { email, password: "test-password-123" });
    expect(result.created).toBe(false);
    expect(result.role).toBe(UserRole.OFFICE_STAFF);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe(UserRole.OFFICE_STAFF);
  });
});
