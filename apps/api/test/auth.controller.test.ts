import { type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AuthController } from "../src/modules/auth/auth.controller";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import type { AuthenticatedRequest } from "../src/modules/auth/auth.types";

// Controller boundary test for AuthController's GET /me. auth.guard.test.ts
// pins WHO gets in (the guard); this file pins the RESPONSE CONTRACT of the
// single route that guard protects: given an authenticated request, me()
// returns exactly { id, email } shaped from req.session.user — nothing more,
// nothing less.
//
// Why this exists: every other Phase-1 controller has a boundary test, but
// /me had none, so a regression that renamed a session field, leaked the
// whole user object, or echoed the session token would not be caught.
//
// Pattern mirrors reports.controller.test.ts: the controller method is called
// directly against a TestingModule with AuthGuard overridden pass-through (the
// AUTH provider stub satisfies the guard's DI). me() never touches Prisma, so
// this file does not reset or seed the test database.

// A minimal session payload shaped like better-auth's getSession return (see
// the VALID_SESSION shape in auth.guard.test.ts). Only req.session.user.id and
// req.session.user.email are read by me(); the extra fields (name, the session
// token) are present precisely so the "does not leak" assertion has something
// to catch if me() ever started spreading the user or returning the session.
function makeRequest(user: { id: string; email: string; name?: string }): AuthenticatedRequest {
  return {
    session: {
      session: {
        id: "sess_test",
        token: "tok_secret_must_not_leak",
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
      user: {
        id: user.id,
        email: user.email,
        name: user.name ?? "Test Admin",
      },
    },
  } as unknown as AuthenticatedRequest;
}

describe("AuthController GET /me (response contract)", () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let controller: AuthController;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        // AuthGuard's constructor depends on AUTH; the override below replaces
        // the guard, but Nest still resolves its declared deps, so a benign
        // stub keeps DI from failing on the AUTH token. Mirror of
        // reports.controller.test.ts.
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    controller = moduleRef.get(AuthController);
  });

  afterAll(async () => {
    await app.close();
  });

  test("returns exactly { id, email } from the attached session", () => {
    const result = controller.me(makeRequest({ id: "user_abc", email: "admin@fleetco.local" }));
    expect(result).toEqual({ id: "user_abc", email: "admin@fleetco.local" });
  });

  test("does not leak any field beyond id and email", () => {
    // A refactor that spread req.session.user (leaking `name`) or returned the
    // session (leaking the token) would surface here. Pinning the exact key
    // set is the contract.
    const result = controller.me(
      makeRequest({ id: "user_xyz", email: "ceo@fleetco.local", name: "CEO" }),
    );
    expect(Object.keys(result).sort()).toEqual(["email", "id"]);
  });

  test("maps id and email straight through without swapping them", () => {
    // Distinct, non-interchangeable values so a swapped-field regression
    // (returning { id: email, email: id }) is caught.
    const result = controller.me(makeRequest({ id: "id-1111", email: "distinct@example.com" }));
    expect(result.id).toBe("id-1111");
    expect(result.email).toBe("distinct@example.com");
  });
});
