import { ServiceUnavailableException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { HealthController } from "../src/modules/health/health.controller";
import { HealthService } from "../src/modules/health/health.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { RedisService } from "../src/modules/redis/redis.service";

// Tests for HealthController and HealthService. The kickoff (item 3b)
// names two routes: `/health/live` (200 unconditionally) and
// `/health/ready` (200 when Prisma can SELECT 1; 503 otherwise). The
// shipped controller (apps/api/src/modules/health/health.controller.ts)
// exposes a slightly different surface: `@Get()` on the `/health`
// prefix (no `/live` segment) returns `{ ok: true }` unconditionally;
// `@Get("ready")` returns `{ ok, db, redis }` or throws 503. The
// tests below cover the actual shipped surface; the route-name
// discrepancy is not in scope for this PR (the framework ticket pays
// off test coverage debt; renaming a route is its own ticket if the
// PO wants the `/live` URL).
//
// The DB-up case uses the real PrismaService against the test database
// — the whole point of the integration framework is to catch seam
// bugs at the Prisma layer (ADR-0023 §4 calls this out). The DB-down
// case mocks PrismaService's $queryRaw to throw, because there is no
// good way to "stop the test database" from within a test without
// affecting other tests in the suite. Redis is mocked in both cases
// because the readiness endpoint also checks Redis and the test
// environment may or may not have a Redis available — the test should
// not depend on that. Once a future ticket adds a Redis-up integration
// test (e.g., for a cache-touching service), this file is the natural
// place to swap the mock for a real RedisService.

describe("HealthController", () => {
  describe("@Get() — liveness probe", () => {
    // The shipped surface is `/health` (no `/live` suffix); see the
    // header comment above for the discrepancy with the kickoff.
    let module: TestingModule;
    let controller: HealthController;

    beforeAll(async () => {
      // Liveness does no I/O at all; it returns `{ ok: true }`
      // synchronously. We still wire fake Prisma/Redis providers so
      // the HealthService can be constructed (the controller pulls in
      // HealthService for the @Get("ready") method on the same class).
      module = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          HealthService,
          {
            provide: PrismaService,
            useValue: {
              $queryRaw: () => Promise.resolve([{ "?column?": 1 }]),
            },
          },
          {
            provide: RedisService,
            useValue: { ping: () => Promise.resolve("PONG") },
          },
        ],
      }).compile();

      controller = module.get(HealthController);
    });

    afterAll(async () => {
      await module.close();
    });

    test("returns { ok: true } unconditionally", () => {
      // The kickoff calls this "returns 200 unconditionally". The
      // controller method is sync and returns a literal; the HTTP
      // status is 200 by Nest's default for a value-returning method.
      // We assert on the body shape because that is what the contract
      // is — the deploy-time liveness probe parses `body.ok` to
      // decide whether to keep the container running.
      expect(controller.check()).toEqual({ ok: true });
    });
  });

  describe("@Get('ready') — readiness probe", () => {
    // Real PrismaService against the test DB; fake Redis (see header).
    let module: TestingModule;
    let prisma: PrismaService;
    let controller: HealthController;

    beforeAll(async () => {
      module = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          HealthService,
          PrismaService,
          {
            provide: RedisService,
            useValue: { ping: () => Promise.resolve("PONG") },
          },
        ],
      }).compile();

      // Trigger Nest's onModuleInit so PrismaService.$connect() runs.
      await module.init();
      prisma = module.get(PrismaService);
      controller = module.get(HealthController);
    });

    afterAll(async () => {
      // Close the module so PrismaService.$disconnect() runs;
      // otherwise the test process hangs on the open DB connection
      // and Vitest emits an "unfinished workers" warning.
      await module.close();
    });

    test("returns 200 with { ok: true, db: 'up', redis: 'up' } when Prisma can SELECT 1", async () => {
      // The body shape assertion is the contract; the HTTP-200 part
      // is implicit because the method returns the body without
      // throwing (a 503 would come from ServiceUnavailableException).
      // The literal `up` strings are the ProbeStatus union from
      // health.service.ts — checked here as a string match so a typo
      // in the source (e.g., `"OK"` instead of `"up"`) would fail
      // even though TypeScript would catch the same typo.
      const body = await controller.ready();
      expect(body).toEqual({ ok: true, db: "up", redis: "up" });

      // Cross-check: the real Prisma round-trip actually happened. If
      // a future refactor short-circuits the pingDatabase() call
      // (returning "up" without querying), this assertion would still
      // pass — by design, since the contract is "db is reachable".
      // The seam this test protects is "the Prisma client is wired
      // and the test DB schema is in place"; both are verified by
      // the body shape above. We assert one extra real query here as
      // a sanity check that PrismaService is the real one.
      const rows = await prisma.$queryRaw<{ result: number }[]>`SELECT 1 AS result`;
      expect(rows).toEqual([{ result: 1 }]);
    });

    test("throws ServiceUnavailableException (503) with { ok: false, db: 'down' } when Prisma fails", async () => {
      // The DB-down case needs a controlled failure on $queryRaw.
      // Building a second TestingModule with a $queryRaw stub that
      // throws is the cleanest path: it scopes the failure to this
      // test, leaves the outer module's real PrismaService untouched,
      // and matches the runbook entry for the 503 case (Prisma cannot
      // SELECT 1). The exception's getResponse() body is what the
      // HTTP response body would be in production.
      const failModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [
          HealthService,
          {
            provide: PrismaService,
            useValue: {
              $queryRaw: () => Promise.reject(new Error("connection refused")),
            },
          },
          {
            provide: RedisService,
            useValue: { ping: () => Promise.resolve("PONG") },
          },
        ],
      }).compile();

      const failController = failModule.get(HealthController);
      try {
        await failController.ready();
        throw new Error("expected ServiceUnavailableException");
      } catch (error) {
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        const body = (error as ServiceUnavailableException).getResponse() as {
          ok: boolean;
          db: string;
          redis: string;
        };
        expect(body.ok).toBe(false);
        expect(body.db).toBe("down");
        expect(body.redis).toBe("up");
      } finally {
        await failModule.close();
      }
    });
  });
});
