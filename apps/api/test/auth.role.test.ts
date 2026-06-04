import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createAuth, type AuthInstance } from "../src/modules/auth/auth";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for the RBAC `role` field (ADR-0028, ticket T_ROLE)
// against a real Postgres AND the real better-auth instance. auth.controller
// .test.ts pins the /me RESPONSE shape against a mock session; this file pins
// the data-layer + library guarantees underneath it that the mock cannot see:
//
//   1. The ADD COLUMN default — a user created WITHOUT an explicit role is
//      OFFICE_STAFF (least privilege, ADR-0028 c8). This is what makes the
//      migration safe for every NEW user.
//   2. The migration BACKFILL — `UPDATE "user" SET "role" = 'ADMIN'` flips an
//      existing OFFICE_STAFF row to ADMIN. This is exactly the statement the
//      20260604030800_add_rbac_role migration runs so the one pre-existing
//      user (the CEO admin) keeps full access (c8). On a fresh DB the real
//      migration matches zero rows, so it can't be observed there; here we
//      recreate the pre-existing-user scenario and assert the flip.
//   3. The better-auth create path — signUpEmail applies the OFFICE_STAFF
//      defaultValue declared in auth.ts. `input: false` means role is never
//      read from the request body, so the default is what populates it — the
//      privilege-escalation defense and the least-privilege default in one.
//   4. The session attach point (ADR-0028 c3) — role rides session.user.role,
//      so getSession returns it with no extra query. This is the runtime
//      guarantee both the RolesGuard (T_GUARD) and /me (this slice) build on.
//
// Why a real better-auth instance and not a mock: tests 3 and 4 are the only
// thing that proves the additionalFields wiring actually populates role at
// runtime. The type system proves the field EXISTS on the session; only an
// end-to-end signUp + getSession proves it is FILLED.

describe("RBAC role field (integration, real Postgres + better-auth)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let auth: AuthInstance;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    // The real better-auth instance, wired to the same Postgres the tests
    // reset between cases. PrismaService extends PrismaClient, so it satisfies
    // createAuth's parameter directly — the same instance AuthModule builds.
    auth = createAuth(prisma);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  test("a user created without an explicit role defaults to OFFICE_STAFF (least privilege)", async () => {
    const id = `user_${randomUUID()}`;
    await prisma.user.create({
      data: { id, email: `staff-${id}@fleetco.test`, name: "Test Staff" },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(user.role).toBe(UserRole.OFFICE_STAFF);
  });

  test("the migration backfill promotes existing users to ADMIN", async () => {
    // Recreate the scenario the add_rbac_role migration faces in production: a
    // user that already exists when the column is added (and is therefore set
    // to the OFFICE_STAFF default by ADD COLUMN), then run the SAME backfill
    // statement the migration runs. The CEO admin must end up ADMIN — without
    // this backfill they would be silently downgraded and locked out.
    const id = `user_${randomUUID()}`;
    await prisma.user.create({
      data: { id, email: `ceo-${id}@fleetco.test`, name: "CEO" },
    });

    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(before.role).toBe(UserRole.OFFICE_STAFF); // the ADD COLUMN default

    // The exact statement migration.sql runs. Static SQL, no interpolation.
    await prisma.$executeRawUnsafe(`UPDATE "user" SET "role" = 'ADMIN';`);

    const after = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(after.role).toBe(UserRole.ADMIN);
  });

  test("better-auth signUpEmail applies the OFFICE_STAFF default (role is never client input)", async () => {
    const email = `signup-${randomUUID()}@fleetco.test`;
    await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "Signed Up" },
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe(UserRole.OFFICE_STAFF);
  });

  test("role rides the session — getSession returns session.user.role (ADR-0028 c3)", async () => {
    const email = `session-${randomUUID()}@fleetco.test`;
    const signUp = await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "Session User" },
      returnHeaders: true,
    });

    // Turn the response's Set-Cookie header(s) into a Cookie request header:
    // each Set-Cookie is "<name>=<value>; Path=/; HttpOnly; ...", and the
    // Cookie header wants just the "<name>=<value>" pairs joined by "; ".
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session).not.toBeNull();
    expect(session?.user.role).toBe(UserRole.OFFICE_STAFF);
  });
});
