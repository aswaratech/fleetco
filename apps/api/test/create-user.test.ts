import { randomUUID } from "node:crypto";

import { Test, type TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createUser, parseRoleArg } from "../scripts/create-user";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Tests for the create-user office-staff / admin seeding path (ADR-0028 c8,
// ticket T_WIRE). Two layers:
//
//   1. parseRoleArg — the PURE arg-parsing policy (no DB): an omitted role
//      argument defaults to the least-privilege OFFICE_STAFF (c8); ADMIN is
//      granted only when requested explicitly; DRIVER is the driver-app login
//      role (ADR-0034), also requested explicitly.
//   2. createUser — the real create path against a real Postgres AND the real
//      better-auth instance: the role is set by the privileged Prisma write
//      AFTER signUpEmail (because `input: false` blocks role through the public
//      API), and the operation is idempotent on email (a second run is a no-op
//      that never mutates an existing account's role).
//
// Why a real better-auth instance and not a mock: the ADMIN assertion below is
// only meaningful end-to-end. signUpEmail applies the OFFICE_STAFF default
// (input:false ignores any role), so a row that ends up ADMIN proves the
// post-signUp privileged Prisma write actually ran — a mock could not.

describe("parseRoleArg (pure role-argument policy)", () => {
  test("an omitted role defaults to OFFICE_STAFF (least privilege, ADR-0028 c8)", () => {
    expect(parseRoleArg(undefined)).toBe(UserRole.OFFICE_STAFF);
  });

  test("ADMIN is accepted only when requested explicitly", () => {
    expect(parseRoleArg("ADMIN")).toBe(UserRole.ADMIN);
  });

  test("OFFICE_STAFF is accepted explicitly", () => {
    expect(parseRoleArg("OFFICE_STAFF")).toBe(UserRole.OFFICE_STAFF);
  });

  test("DRIVER is accepted — the driver-app login role (ADR-0034)", () => {
    expect(parseRoleArg("DRIVER")).toBe(UserRole.DRIVER);
  });

  test("an unknown role string is rejected", () => {
    expect(() => parseRoleArg("superuser")).toThrow(/Invalid role/);
  });
});

describe("createUser (integration, real Postgres + better-auth)", () => {
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

  test("creates an OFFICE_STAFF user with the role set", async () => {
    const email = `staff-${randomUUID()}@fleetco.test`;
    const result = await createUser(prisma, {
      email,
      password: "test-password-123",
      role: UserRole.OFFICE_STAFF,
    });

    expect(result.created).toBe(true);
    expect(result.role).toBe(UserRole.OFFICE_STAFF);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe(UserRole.OFFICE_STAFF);
  });

  test("creates an ADMIN via the privileged Prisma write (signUp alone would default to OFFICE_STAFF)", async () => {
    const email = `admin-${randomUUID()}@fleetco.test`;
    const result = await createUser(prisma, {
      email,
      password: "test-password-123",
      role: UserRole.ADMIN,
    });

    expect(result.created).toBe(true);
    expect(result.role).toBe(UserRole.ADMIN);

    // The load-bearing assertion: ADMIN proves the post-signUp prisma.user
    // .update ran. `input: false` means signUpEmail ignores any role and
    // applies the OFFICE_STAFF default; only the explicit privileged write
    // (ADR-0028 c8) yields ADMIN.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe(UserRole.ADMIN);
  });

  test("is idempotent on email — a second run is a no-op that never mutates the existing role", async () => {
    const email = `dup-${randomUUID()}@fleetco.test`;

    const first = await createUser(prisma, {
      email,
      password: "test-password-123",
      role: UserRole.ADMIN,
    });
    expect(first.created).toBe(true);
    expect(first.role).toBe(UserRole.ADMIN);

    // Re-run with the SAME email but a DIFFERENT requested role. The second
    // call must NOT create a duplicate and must NOT downgrade the existing
    // ADMIN — re-running creation never changes a role (that is a deliberate,
    // separate privileged action). It reports the existing account unchanged.
    const second = await createUser(prisma, {
      email,
      password: "test-password-123",
      role: UserRole.OFFICE_STAFF,
    });
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.role).toBe(UserRole.ADMIN);

    expect(await prisma.user.count()).toBe(1);
  });

  test("creates a DRIVER login via the privileged write (the driver-app role, ADR-0034)", async () => {
    const email = `driver-${randomUUID()}@fleetco.test`;
    const result = await createUser(prisma, {
      email,
      password: "test-password-123",
      role: UserRole.DRIVER,
    });

    expect(result.created).toBe(true);
    expect(result.role).toBe(UserRole.DRIVER);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe(UserRole.DRIVER);
  });
});
