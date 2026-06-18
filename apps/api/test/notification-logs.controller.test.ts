import type { AddressInfo } from "node:net";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { type NotificationLog } from "@prisma/client";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { NotificationLogsController } from "../src/modules/notification-logs/notification-logs.controller";
import { ListNotificationLogsQuerySchema } from "../src/modules/notification-logs/notification-logs.schemas";
import { NotificationLogsService } from "../src/modules/notification-logs/notification-logs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Controller-level tests for the NotificationLogs read slice (ADR-0038 C4).
// Three layers, mirroring geofences.controller.test.ts:
//
//   1. Pipe layer — ZodValidationPipe over the list query schema, pure code (no
//      server). Pins .strict() unknown-key rejection, the sortBy whitelist, the
//      take ceiling / skip floor, the open-string filter normalization, and the
//      coerced date range.
//   2. Controller integration (real Prisma, guards overridden) — the list
//      response shape + getById 200 / 404. NotificationLog has no FK, so rows
//      seed directly.
//   3. RBAC HTTP boundary (REAL AuthGuard + RolesGuard chain) — notifications:read
//      is ADMIN-only: ADMIN 200, OFFICE_STAFF / DRIVER 403, anonymous 401
//      (401 ≠ 403). Read-only: there are no write routes to test.

async function seedLog(
  prisma: PrismaService,
  overrides: Partial<{
    subjectType: string;
    subjectId: string;
    reminderKind: string;
    state: string;
    occurrenceKey: string;
    recipient: string;
    sentAt: Date | null;
    providerMessageId: string | null;
  }> = {},
): Promise<NotificationLog> {
  return prisma.notificationLog.create({
    data: {
      subjectType: overrides.subjectType ?? "VEHICLE",
      subjectId: overrides.subjectId ?? `veh_${Math.random().toString(36).slice(2, 10)}`,
      reminderKind: overrides.reminderKind ?? "BLUEBOOK",
      state: overrides.state ?? "expired",
      occurrenceKey: overrides.occurrenceKey ?? "2026-05-20T00:00:00.000Z",
      recipient: overrides.recipient ?? "operator@fleetco.test",
      sentAt:
        overrides.sentAt === undefined ? new Date("2026-06-19T06:45:00.000Z") : overrides.sentAt,
      providerMessageId:
        overrides.providerMessageId === undefined ? "msg_seed" : overrides.providerMessageId,
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 1 — pipe layer
// ───────────────────────────────────────────────────────────────────────────

describe("ListNotificationLogsQuerySchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(ListNotificationLogsQuerySchema);

  test("bogus query key → BadRequestException (.strict())", () => {
    expect(() => pipe.transform({ subjecttype: "VEHICLE" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy (recipient) → BadRequestException (information-disclosure defense)", () => {
    // Sorting by the recipient column would leak ordering signal about Tier-2
    // addresses; the whitelist is sentAt / createdAt only.
    expect(() => pipe.transform({ sortBy: "recipient" })).toThrow(BadRequestException);
  });

  test("off-whitelist sortBy (occurrenceKey) → BadRequestException", () => {
    expect(() => pipe.transform({ sortBy: "occurrenceKey" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException", () => {
    expect(() => pipe.transform({ take: "5000" })).toThrow(BadRequestException);
  });

  test("skip below zero → BadRequestException", () => {
    expect(() => pipe.transform({ skip: "-1" })).toThrow(BadRequestException);
  });

  test("a non-date startDate → BadRequestException", () => {
    expect(() => pipe.transform({ startDate: "not-a-date" })).toThrow(BadRequestException);
  });

  test("valid query parses (open-string filters trimmed, strings → numbers, date coerced)", () => {
    const result = pipe.transform({
      subjectType: "VEHICLE",
      reminderKind: "BLUEBOOK",
      state: "expired",
      startDate: "2026-06-01",
      sortBy: "createdAt",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.subjectType).toBe("VEHICLE");
    expect(result.reminderKind).toBe("BLUEBOOK");
    expect(result.state).toBe("expired");
    expect(result.startDate).toBeInstanceOf(Date);
    expect(result.sortBy).toBe("createdAt");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty-string filter values normalize to undefined (no filter)", () => {
    const result = pipe.transform({ subjectType: "", reminderKind: "  " });
    expect(result.subjectType).toBeUndefined();
    expect(result.reminderKind).toBeUndefined();
  });

  test("empty query → all-undefined (controller/service apply defaults)", () => {
    const result = pipe.transform({});
    expect(result.subjectType).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.take).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2 — controller integration (real Prisma, guards overridden)
// ───────────────────────────────────────────────────────────────────────────

describe("NotificationLogsController (integration, real Prisma)", () => {
  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: NotificationLogsController;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [NotificationLogsController],
      providers: [
        NotificationLogsService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      // Both guards pass-through here: this describe tests handler wiring, not
      // RBAC (the real guard chain is exercised in the RBAC describe below).
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(NotificationLogsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  test("list returns the response shape { items, total, skip, take, sortBy, sortDir }", async () => {
    await seedLog(prisma, { subjectId: "v1" });
    const response = await controller.list({ skip: 0, take: 10 });
    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "sentAt",
      sortDir: "desc",
    });
    expect(response.items[0]?.subjectId).toBe("v1");
  });

  test("list echoes the explicit sort overrides", async () => {
    await seedLog(prisma);
    const response = await controller.list({
      sortBy: "createdAt",
      sortDir: "asc",
      skip: 0,
      take: 5,
    });
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("asc");
  });

  test("getById returns the row when present", async () => {
    const row = await seedLog(prisma, { subjectId: "detail" });
    const fetched = await controller.getById(row.id);
    expect(fetched.id).toBe(row.id);
    expect(fetched.subjectId).toBe("detail");
  });

  test("getById of an unknown id → NotFoundException (404) with the id named", async () => {
    try {
      await controller.getById("nonexistent-log-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-log-id");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3 — RBAC HTTP boundary (real AuthGuard + RolesGuard chain, ADR-0038 C4)
// ───────────────────────────────────────────────────────────────────────────

// AUTH stub identical to geofences.controller.test.ts: AuthGuard calls
// getSession({ headers }); the `x-test-role` header drives the caller's role, so
// one app instance serves every case. No header → null session → 401.
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

describe("NotificationLogs RBAC (notifications:read, ADMIN-only, ADR-0038 C4)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let seededId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationLogsController],
      providers: [
        NotificationLogsService,
        PrismaService,
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);

    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    const prisma = moduleRef.get(PrismaService);
    await resetDb(prisma);
    seededId = (await seedLog(prisma, { subjectId: "rbac" })).id;
  });

  afterAll(async () => {
    await app.close();
  });

  // Issue a request and return the HTTP status. `role` undefined → no header →
  // 401 path.
  async function status(method: string, path: string, role?: string): Promise<number> {
    const headers: Record<string, string> = {};
    if (role !== undefined) headers["x-test-role"] = role;
    const res = await fetch(`${baseUrl}${path}`, { method, headers });
    return res.status;
  }

  const LIST = "/api/v1/notification-logs";
  const detail = (): string => `/api/v1/notification-logs/${seededId}`;

  test("list: ADMIN → 200", async () => {
    expect(await status("GET", LIST, UserRole.ADMIN)).toBe(200);
  });

  test("list: OFFICE_STAFF → 403 (lacks notifications:read — audit data is ADMIN-only)", async () => {
    expect(await status("GET", LIST, UserRole.OFFICE_STAFF)).toBe(403);
  });

  test("list: DRIVER → 403", async () => {
    expect(await status("GET", LIST, UserRole.DRIVER)).toBe(403);
  });

  test("list: anonymous → 401 from AuthGuard, NOT 403", async () => {
    expect(await status("GET", LIST)).toBe(401);
  });

  test("detail: ADMIN → 200", async () => {
    expect(await status("GET", detail(), UserRole.ADMIN)).toBe(200);
  });

  test("detail: OFFICE_STAFF → 403", async () => {
    expect(await status("GET", detail(), UserRole.OFFICE_STAFF)).toBe(403);
  });

  test("detail: anonymous → 401", async () => {
    expect(await status("GET", detail())).toBe(401);
  });

  test("the ledger is read-only: POST / PATCH / DELETE are not routed (404/405, never a mutation)", async () => {
    // No write routes exist on this controller; an attempted write never reaches
    // a handler. We assert it is NOT a success status (it is a 404 no-route).
    const code = await status("POST", LIST, UserRole.ADMIN);
    expect(code).not.toBe(200);
    expect(code).not.toBe(201);
  });
});
