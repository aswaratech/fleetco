import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { createAuth, type AuthInstance } from "../src/modules/auth/auth";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for bearer-token auth (ADR-0034 c1) against a real Postgres
// + the real better-auth instance. The native driver client cannot ride the
// web's httpOnly cookie session, so the bearer() plugin (auth.ts) lets it
// present `Authorization: Bearer <token>` instead. These pin two guarantees the
// type system cannot:
//
//   1. NEW capability — a token issued at sign-up (the bearer plugin's
//      `set-auth-token` response header, the value the Expo client stores in
//      expo-secure-store) resolves a full session via
//      getSession({ headers: { Authorization: `Bearer <token>` } }). This is the
//      seam @better-auth/expo rides; AuthGuard already calls
//      getSession({ headers: fromNodeHeaders(...) }), so no guard change.
//   2. REGRESSION — the plugin is ADDITIVE: the web admin's cookie session still
//      resolves (auth.role.test.ts also exercises the cookie path; this
//      re-asserts it in the bearer file so the "both coexist" guarantee is
//      observable in one place).
//
// Why a real better-auth instance: only an end-to-end signUp + getSession proves
// the bearer plugin actually issues and resolves a token at runtime — the
// additive coexistence with cookies cannot be seen by a mock.

describe("Bearer + cookie auth coexistence (integration, real Postgres + better-auth)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let auth: AuthInstance;

  beforeAll(async () => {
    module = await Test.createTestingModule({ providers: [PrismaService] }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    // The real better-auth instance, wired to the same Postgres the tests reset
    // between cases — the same instance AuthModule builds (mirrors
    // auth.role.test.ts). PrismaService extends PrismaClient, so it satisfies
    // createAuth's parameter directly.
    auth = createAuth(prisma);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  test("a bearer token issued at sign-up resolves a session via Authorization: Bearer (ADR-0034 c1)", async () => {
    const email = `bearer-${randomUUID()}@fleetco.test`;
    const signUp = await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "Bearer User" },
      returnHeaders: true,
    });

    // The bearer plugin exposes the signed session token on the `set-auth-token`
    // response header — the value @better-auth/expo stores in expo-secure-store
    // and replays as `Authorization: Bearer <token>` on every request.
    const token = signUp.headers.get("set-auth-token");
    expect(token).toBeTruthy();

    const session = await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${token}` }),
    });
    expect(session).not.toBeNull();
    expect(session?.user.email).toBe(email);
    expect(session?.user.role).toBe(UserRole.OFFICE_STAFF);
  });

  test("a bogus bearer token resolves no session (the token is validated, not trusted)", async () => {
    const session = await auth.api.getSession({
      headers: new Headers({ Authorization: "Bearer not-a-real-token" }),
    });
    expect(session).toBeNull();
  });

  test("the web admin cookie session still resolves after bearer is enabled (additive regression)", async () => {
    const email = `cookie-${randomUUID()}@fleetco.test`;
    const signUp = await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "Cookie User" },
      returnHeaders: true,
    });
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session).not.toBeNull();
    expect(session?.user.email).toBe(email);
  });
});
