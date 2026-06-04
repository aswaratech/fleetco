import {
  Controller,
  ForbiddenException,
  Get,
  UseGuards,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { type Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_ROLE_KEY,
  RequirePermission,
  RequireRole,
} from "../src/modules/auth/decorators";
import { type Capability } from "../src/modules/auth/permissions";
import { RolesGuard } from "../src/modules/auth/roles.guard";

// Tests for RolesGuard (ADR-0028 T_GUARD), in two parts that mirror how the
// auth slice is already tested (auth.guard.test.ts = unit; auth.controller/
// auth.role = wired):
//
//   1. UNIT — mock ExecutionContext + a stubbed Reflector, exactly like
//      auth.guard.test.ts. These pin the guard's decision logic in isolation:
//      capable -> allow, not-capable -> 403, no decorator -> allow (opt-in),
//      and the fail-closed narrowing of an unexpected session role. The 401
//      no-session path is deliberately NOT tested here — it stays AuthGuard's
//      responsibility (ADR-0028 c5).
//   2. HTTP BOUNDARY — a THROWAWAY controller wired behind the REAL
//      @UseGuards(AuthGuard, RolesGuard) chain inside a TestingModule, hit over
//      real HTTP. This proves the end-to-end 403-vs-allow behavior (and that
//      401 != 403) through NestJS's actual guard pipeline and exception layer —
//      the seam a unit test cannot see. No real gated endpoint is added to the
//      app (there is no sensitive surface yet; ADR-0028 c5 keeps Phase-1
//      controllers ungated) — the throwaway controller exists only to exercise
//      the wiring.
//
// The AUTH provider is stubbed in both parts because we are testing OUR guard,
// not better-auth's session validation (the library's job). In part 2 the REAL
// AuthGuard runs and attaches the session; only the session SOURCE (getSession)
// is the stub, driven by an `x-test-role` header so one app instance serves
// every role.

// ---------------------------------------------------------------------------
// Part 1 — unit
// ---------------------------------------------------------------------------

interface RequiredMeta {
  role?: UserRole;
  permission?: Capability;
}

// The kickoff's "stubbed Reflector": getAllAndOverride returns the configured
// requirement per metadata key. Casting through unknown is the established
// test-double pattern (see auth.guard.test.ts's ExecutionContext) and doubles
// only the single method the guard calls.
function stubReflector(meta: RequiredMeta): Reflector {
  return {
    getAllAndOverride: (key: string): unknown => {
      if (key === REQUIRE_ROLE_KEY) return meta.role;
      if (key === REQUIRE_PERMISSION_KEY) return meta.permission;
      return undefined;
    },
  } as unknown as Reflector;
}

// Mock ExecutionContext whose request carries the role AuthGuard would have
// attached. When `sessionReadThrows` is set, reading the request throws — so a
// passing test PROVES the guard never touched the session on that path (used
// for the opt-in / no-decorator case).
function makeContext(opts: {
  role?: string | null;
  sessionReadThrows?: boolean;
}): ExecutionContext {
  const http = {
    getRequest: <T = unknown>(): T => {
      if (opts.sessionReadThrows) {
        throw new Error("RolesGuard must not read the session when no decorator is present");
      }
      return { session: { user: { role: opts.role } } } as T;
    },
    getResponse: <T = unknown>(): T => {
      throw new Error("RolesGuard must not touch the response object");
    },
    getNext: <T = unknown>(): T => {
      throw new Error("RolesGuard must not touch the next() function");
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

function evaluate(
  meta: RequiredMeta,
  ctx: { role?: string | null; sessionReadThrows?: boolean },
): boolean {
  return new RolesGuard(stubReflector(meta)).canActivate(makeContext(ctx));
}

describe("RolesGuard (unit: stubbed Reflector + mock ExecutionContext)", () => {
  test("authed + capable → true (@RequirePermission satisfied)", () => {
    expect(evaluate({ permission: "gps:read-raw" }, { role: UserRole.ADMIN })).toBe(true);
  });

  test("authed + not capable → 403 ForbiddenException (distinct from AuthGuard's 401)", () => {
    // OFFICE_STAFF lacks gps:read-raw (ADR-0028 c4). The deny must be a 403
    // (ForbiddenException), DELIBERATELY distinct from AuthGuard's 401 — the
    // contract ADR-0028 c5 fixes. Pin the status, not just the throw.
    let caught: unknown;
    try {
      evaluate({ permission: "gps:read-raw" }, { role: UserRole.OFFICE_STAFF });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as ForbiddenException).getStatus()).toBe(403);
  });

  test("OFFICE_STAFF holds the derived-GPS capability → true", () => {
    // The positive half of the GPS raw-vs-derived split (ADR-0028 c6): office
    // staff DO get gps:read-derived (live map / geofence / route summary).
    expect(evaluate({ permission: "gps:read-derived" }, { role: UserRole.OFFICE_STAFF })).toBe(
      true,
    );
  });

  test("no decorator → true (opt-in restriction), without reading the session", () => {
    // Opt-in restriction (ADR-0028 c5): an undecorated route stays open to any
    // authenticated caller. sessionReadThrows proves the guard short-circuits
    // before touching the session in this path.
    expect(evaluate({}, { sessionReadThrows: true })).toBe(true);
  });

  test("@RequireRole match → true", () => {
    expect(evaluate({ role: UserRole.ADMIN }, { role: UserRole.ADMIN })).toBe(true);
  });

  test("@RequireRole mismatch → ForbiddenException", () => {
    expect(() => evaluate({ role: UserRole.ADMIN }, { role: UserRole.OFFICE_STAFF })).toThrow(
      ForbiddenException,
    );
  });

  test("DRIVER is inert — reserved role holds no capability → ForbiddenException", () => {
    // DRIVER is reserved-but-undefined (ADR-0028 c1): even the derived-GPS view
    // every live role has is denied, because DRIVER's capability set is empty.
    expect(() => evaluate({ permission: "gps:read-derived" }, { role: UserRole.DRIVER })).toThrow(
      ForbiddenException,
    );
  });

  test("an unexpected session role fails closed — denied a sensitive capability", () => {
    // A corrupted/empty role narrows to OFFICE_STAFF (toUserRole), so an
    // ADMIN-only capability is denied, never silently widened.
    expect(() => evaluate({ permission: "gps:read-raw" }, { role: "SUPER_USER" })).toThrow(
      ForbiddenException,
    );
  });

  test("an unexpected session role still satisfies the operational floor (OFFICE_STAFF)", () => {
    // The same fail-closed value (OFFICE_STAFF) DOES hold operational caps, so
    // an unknown value is denied sensitive caps but keeps operational access —
    // pinning exactly where the fail-closed floor sits.
    expect(evaluate({ permission: "vehicles:*" }, { role: "SUPER_USER" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — HTTP boundary (throwaway controller, real guard chain)
// ---------------------------------------------------------------------------

// Throwaway controller — exists ONLY in this test to exercise the real
// @UseGuards(AuthGuard, RolesGuard) chain end-to-end. It is never registered in
// the application (ADR-0028 c5: no sensitive surface exists yet; Phase-1
// controllers stay ungated). One route per decorator shape plus one undecorated
// route to prove the opt-in default.
@Controller("__test-rbac")
class TestRbacController {
  @Get("admin-only")
  @UseGuards(AuthGuard, RolesGuard)
  @RequireRole(UserRole.ADMIN)
  adminOnly(): { ok: string } {
    return { ok: "admin-only" };
  }

  @Get("raw-gps")
  @UseGuards(AuthGuard, RolesGuard)
  @RequirePermission("gps:read-raw")
  rawGps(): { ok: string } {
    return { ok: "raw-gps" };
  }

  @Get("open")
  @UseGuards(AuthGuard, RolesGuard)
  open(): { ok: string } {
    return { ok: "open" };
  }
}

// AUTH stub: AuthGuard calls getSession({ headers }). We drive the caller's
// role via an `x-test-role` request header so ONE app instance serves every
// case. A missing header → null session → AuthGuard throws 401 (which lets us
// assert 401 != 403 at the HTTP boundary). The session shape mirrors
// better-auth's getSession return (see auth.guard.test.ts's VALID_SESSION).
const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
      return {
        session: {
          id: "sess_test",
          token: "tok_test",
          userId: "user_test",
          expiresAt: new Date(Date.now() + 60_000),
        },
        user: { id: "user_test", email: "user@fleetco.test", name: "Test", role },
      };
    },
  },
};

describe("RolesGuard (HTTP boundary: throwaway controller + real AuthGuard chain)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestRbacController],
      providers: [AuthGuard, RolesGuard, { provide: AUTH, useValue: AUTH_STUB }],
    }).compile();

    // logger:false silences Nest's startup/route-mapping banner so the test
    // output stays clean. listen(0) binds an ephemeral port (fileParallelism is
    // off, so there is no port race).
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);

    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  // Issue a GET and return the HTTP status. `role` undefined → no header → no
  // session (401 path); otherwise the stub returns a session with that role.
  async function status(path: string, role?: string): Promise<number> {
    const headers: Record<string, string> = role === undefined ? {} : { "x-test-role": role };
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.status;
  }

  test("ADMIN on a @RequireRole('ADMIN') route → 200", async () => {
    expect(await status("/__test-rbac/admin-only", UserRole.ADMIN)).toBe(200);
  });

  test("OFFICE_STAFF on a @RequireRole('ADMIN') route → 403 (authed but forbidden)", async () => {
    expect(await status("/__test-rbac/admin-only", UserRole.OFFICE_STAFF)).toBe(403);
  });

  test("ADMIN on a @RequirePermission('gps:read-raw') route → 200", async () => {
    expect(await status("/__test-rbac/raw-gps", UserRole.ADMIN)).toBe(200);
  });

  test("OFFICE_STAFF on a @RequirePermission('gps:read-raw') route → 403", async () => {
    expect(await status("/__test-rbac/raw-gps", UserRole.OFFICE_STAFF)).toBe(403);
  });

  test("an undecorated route is reachable by any authenticated role → 200 (opt-in)", async () => {
    expect(await status("/__test-rbac/open", UserRole.OFFICE_STAFF)).toBe(200);
    expect(await status("/__test-rbac/open", UserRole.ADMIN)).toBe(200);
  });

  test("no session → 401 from AuthGuard, NOT 403 (the 401 != 403 contract)", async () => {
    // The 401 path is AuthGuard's responsibility; asserting it on a ROLE-gated
    // route pins the composed chain's full contract: anonymous → 401,
    // authenticated-but-forbidden → 403.
    expect(await status("/__test-rbac/admin-only")).toBe(401);
  });
});
