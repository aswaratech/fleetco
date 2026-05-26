import { type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AUTH } from "../src/modules/auth/auth.tokens";
import { AuthGuard } from "../src/modules/auth/auth.guard";

// Tests for AuthGuard. The kickoff scope (item 3a) names three cases:
// session-cookie happy path, missing-cookie 401, expired-cookie 401.
// All three reduce to one decision in the guard: "did auth.api.getSession
// return a non-null payload?" — the guard itself does no expiry math.
// (Expiry is enforced inside better-auth's adapter against the
// Session.expiresAt column from prisma/schema.prisma; an expired session
// surfaces here as getSession returning null, exactly like a missing
// cookie.) So the three scope items collapse to two test cases at the
// guard's surface: session present (passes, attaches to request) and
// session absent (throws UnauthorizedException). A third test exercises
// the "the guard reads from request.headers and forwards to better-auth"
// contract, which is the seam most likely to break under refactor.
//
// The AUTH provider is stubbed because we are testing OUR guard, not
// better-auth's session-validation logic — that is the library's job
// and is covered by better-auth's own tests. The kickoff's instruction
// that the test framework must SUPPORT real AuthGuard and real
// PrismaService is honored: we use the real AuthGuard class here, only
// the AUTH provider it depends on is replaced with a controlled stub.
// See ADR-0023 §3 for the broader pattern.

type GetSessionPayload = Awaited<ReturnType<MockAuth["api"]["getSession"]>>;

interface MockAuth {
  api: {
    getSession: (args: { headers: Headers }) => Promise<GetSessionPayload>;
  };
}

// A minimal session payload shaped like better-auth's. Only the fields
// the guard attaches to the request (the whole session object) and the
// fields a downstream controller reads from request.session.user.id
// matter for the assertions below.
const VALID_SESSION = {
  session: {
    id: "sess_test",
    token: "tok_test",
    userId: "user_test",
    expiresAt: new Date(Date.now() + 60_000),
  },
  user: {
    id: "user_test",
    email: "admin@fleetco.local",
    name: "Test Admin",
  },
};

// Build an ExecutionContext that returns a request with the given
// headers; getResponse/getNext are not used by the guard so they are
// stubbed to throw if the guard ever starts touching them (defensive:
// flags an undeclared dependency at test time).
function makeContext(headers: Record<string, string>): ExecutionContext {
  const request: { headers: Record<string, string>; session?: unknown } = { headers };
  const http = {
    getRequest: <T = unknown>(): T => request as T,
    getResponse: <T = unknown>(): T => {
      throw new Error("AuthGuard must not touch the response object");
    },
    getNext: <T = unknown>(): T => {
      throw new Error("AuthGuard must not touch the next() function");
    },
  };
  return {
    switchToHttp: () => http,
    getClass: () => class {},
    getHandler: () => () => undefined,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => {
      throw new Error("not used");
    },
    switchToWs: () => {
      throw new Error("not used");
    },
    getType: () => "http",
  } as unknown as ExecutionContext;
}

// Pull the attached session back off the request the guard mutated so
// the "happy path attaches session" assertion can read it. The guard
// writes to `request.session`; this helper makes that visible to tests
// without re-deriving the request from the ExecutionContext mock.
function readAttachedSession(ctx: ExecutionContext): unknown {
  const req = ctx.switchToHttp().getRequest<{ session?: unknown }>();
  return req.session;
}

describe("AuthGuard", () => {
  let guard: AuthGuard;
  let getSessionImpl: MockAuth["api"]["getSession"];

  beforeAll(async () => {
    // Override via a closure so each test can swap the implementation
    // without re-compiling the TestingModule (which is the slow part).
    const authStub: MockAuth = {
      api: {
        getSession: (args) => getSessionImpl(args),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [AuthGuard, { provide: AUTH, useValue: authStub }],
    }).compile();

    guard = moduleRef.get(AuthGuard);
  });

  afterAll(() => {
    // Nothing to clean up; the test DB is not touched in this file
    // (auth.guard never calls Prisma). Listed here as a placeholder so
    // a future change that introduces a Prisma touch surfaces the
    // missing afterAll cleanup at review time.
  });

  test("session present → returns true and attaches session to request", async () => {
    getSessionImpl = async () => VALID_SESSION;
    const ctx = makeContext({ cookie: "fleetco.session=abc123" });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(readAttachedSession(ctx)).toEqual(VALID_SESSION);
  });

  test("session absent → throws UnauthorizedException (maps to HTTP 401)", async () => {
    // Matches the api-error-mapping runbook entry for "Missing or
    // invalid session cookie". better-auth returns null for missing,
    // malformed, and expired cookies — the guard does not need to
    // distinguish, and neither does this test.
    getSessionImpl = async () => null;
    const ctx = makeContext({});

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(readAttachedSession(ctx)).toBeUndefined();
  });

  test("expired session (better-auth returns null) → throws UnauthorizedException", async () => {
    // better-auth's getSession returns null when the stored
    // Session.expiresAt is in the past. The guard sees the same null
    // it sees for a missing cookie; this test documents that the
    // behavior is identical, so a future reader does not look for a
    // separate "expired" code path that does not exist.
    getSessionImpl = async () => null;
    const ctx = makeContext({ cookie: "fleetco.session=expired-token" });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test("forwards request headers to better-auth's getSession", async () => {
    // Seam check: the guard's job is to translate Node-style headers
    // (record of strings) into Web-style headers (Headers instance) via
    // fromNodeHeaders, then hand them to better-auth. If a refactor
    // accidentally drops the headers (e.g., passes an empty object),
    // every protected route would silently 401. The assertion verifies
    // the Cookie header survives the round trip into getSession's args.
    let receivedCookie: string | null = null;
    getSessionImpl = async ({ headers }) => {
      receivedCookie = headers.get("cookie");
      return VALID_SESSION;
    };

    const ctx = makeContext({ cookie: "fleetco.session=carry-me" });
    await guard.canActivate(ctx);
    expect(receivedCookie).toBe("fleetco.session=carry-me");
  });
});
