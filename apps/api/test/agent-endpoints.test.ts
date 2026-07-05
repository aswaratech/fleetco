import type { AddressInfo } from "node:net";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole, type AgentConversation, type AgentMessage } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AgentController } from "../src/modules/agent/agent.controller";
import { AgentAttachmentsService } from "../src/modules/agent/agent-attachments.service";
import { AgentService } from "../src/modules/agent/agent.service";
import { LlmClient } from "../src/modules/agent/llm-client";
import { MockLlmClient } from "../src/modules/agent/mock-llm.client";
import { AgentToolRegistry } from "../src/modules/agent/tools/tool-registry";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { CustomersService } from "../src/modules/customers/customers.service";
import { DriversService } from "../src/modules/drivers/drivers.service";
import { ExpenseLogsService } from "../src/modules/expense-logs/expense-logs.service";
import { FuelLogsService } from "../src/modules/fuel-logs/fuel-logs.service";
import { GeofencesService } from "../src/modules/geofences/geofences.service";
import { JobsService } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { ReportsService } from "../src/modules/reports/reports.service";
import { ServiceRecordsService } from "../src/modules/maintenance/service-records.service";
import { ServiceSchedulesService } from "../src/modules/maintenance/service-schedules.service";
import { MockVisionExtractor } from "../src/modules/agent/vision/mock.vision-extractor";
import { VisionExtractor } from "../src/modules/agent/vision/vision-extractor";
import { MockObjectStorage } from "../src/modules/storage/mock.object-storage";
import { ObjectStorage } from "../src/modules/storage/object-storage";
import { TripsService } from "../src/modules/trips/trips.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { resetDb } from "./db";
import { seedAgentAction } from "./fixtures/agent-transcript";
import { seedUser } from "./fixtures/trip";

// The agent HTTP surface (ADR-0043 c1/c4/c7, ticket A5): the composed
// AuthGuard + RolesGuard chain enforcing `agent:use` (ADMIN-only in v1) over
// all four routes, the `.strict()` wire validation, and the endpoint shapes
// the A6 chat UI consumes. The loop's own semantics (budgets, action rows,
// redaction) are pinned at the service layer in agent-loop.test.ts; the LLM
// here is the no-network MockLlmClient default reply.

// AUTH stub per the rbac.matrix precedent: `x-test-role` drives the role,
// `x-test-user` the user id; no header → null session → 401.
const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
      const userId = headers.get("x-test-user") ?? "user_agent_admin";
      return {
        session: {
          id: "sess_test",
          token: "tok_test",
          userId,
          expiresAt: new Date(Date.now() + 60_000),
        },
        user: { id: userId, email: `${userId}@fleetco.test`, name: "Test", role },
      };
    },
  },
};

describe("agent endpoints (real guards + Postgres, mock LLM)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;

  let adminId: string;
  let otherAdminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        AgentService,
        AgentToolRegistry,
        VehiclesService,
        DriversService,
        CustomersService,
        JobsService,
        TripsService,
        FuelLogsService,
        ExpenseLogsService,
        GeofencesService,
        ServiceSchedulesService,
        ServiceRecordsService,
        ReportsService,
        DriverScopeService,
        PrismaService,
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        // The DI seam bound exactly as the factory would with no key: the
        // no-network mock (its default reply names the missing key).
        { provide: LlmClient, useValue: new MockLlmClient() },
        // V4: the controller now also carries the attachments service.
        AgentAttachmentsService,
        { provide: ObjectStorage, useValue: new MockObjectStorage() },
        // V7: AgentService carries the vision seam; unconfigured here — the
        // attachment-turn semantics are pinned in agent-loop.test.ts.
        { provide: VisionExtractor, useValue: new MockVisionExtractor() },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    const address: AddressInfo | string | null = app.getHttpServer().address();
    if (typeof address !== "object" || address === null) {
      throw new Error("expected the test server to bind a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma, UserRole.ADMIN);
    otherAdminId = await seedUser(prisma, UserRole.ADMIN);
  });

  async function call(
    method: "GET" | "POST",
    path: string,
    opts: { role?: UserRole; userId?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.role !== undefined) headers["x-test-role"] = opts.role;
    if (opts.userId !== undefined) headers["x-test-user"] = opts.userId;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  }

  async function createConversation(userId: string): Promise<AgentConversation> {
    const res = await call("POST", "/api/v1/agent/conversations", {
      role: UserRole.ADMIN,
      userId,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as AgentConversation;
  }

  // --- the agent:use gate (c1) ---------------------------------------------

  test("anonymous → 401 (AuthGuard)", async () => {
    expect((await call("GET", "/api/v1/agent/conversations")).status).toBe(401);
  });

  test("agent:use is ADMIN-only: OFFICE_STAFF → 403, DRIVER → 403, ADMIN → 200", async () => {
    // OFFICE_STAFF holding the whole operational floor but NOT agent:use is
    // the load-bearing assertion: chat access is a deliberate later grant,
    // not part of the floor.
    expect(
      (await call("GET", "/api/v1/agent/conversations", { role: UserRole.OFFICE_STAFF })).status,
    ).toBe(403);
    expect(
      (await call("GET", "/api/v1/agent/conversations", { role: UserRole.DRIVER })).status,
    ).toBe(403);
    expect(
      (
        await call("GET", "/api/v1/agent/conversations", {
          role: UserRole.ADMIN,
          userId: adminId,
        })
      ).status,
    ).toBe(200);
  });

  test("the gate covers the turn route too (the one that executes tools)", async () => {
    const conversation = await createConversation(adminId);
    const res = await call("POST", `/api/v1/agent/conversations/${conversation.id}/turns`, {
      role: UserRole.OFFICE_STAFF,
      body: { content: "hi" },
    });
    expect(res.status).toBe(403);
  });

  // --- conversations --------------------------------------------------------

  test("POST /conversations creates an empty untitled conversation for the acting user", async () => {
    const conversation = await createConversation(adminId);
    expect(conversation.userId).toBe(adminId);
    expect(conversation.title).toBeNull();
  });

  test("GET /conversations lists ONLY the acting user's own, with the house list shape", async () => {
    await createConversation(adminId);
    await createConversation(otherAdminId);

    const res = await call("GET", "/api/v1/agent/conversations", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: AgentConversation[];
      total: number;
      skip: number;
      take: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.userId).toBe(adminId);
    expect(body.skip).toBe(0);
    expect(body.take).toBe(50);
  });

  test("GET /conversations rejects a typo'd query key and a bogus take (400)", async () => {
    const bad = await call("GET", "/api/v1/agent/conversations?sort=asc", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(bad.status).toBe(400);
    const badTake = await call("GET", "/api/v1/agent/conversations?take=0", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(badTake.status).toBe(400);
  });

  // --- transcript -----------------------------------------------------------

  test("GET /conversations/:id returns the transcript; a foreign or missing one 404s", async () => {
    const conversation = await createConversation(adminId);
    await call("POST", `/api/v1/agent/conversations/${conversation.id}/turns`, {
      role: UserRole.ADMIN,
      userId: adminId,
      body: { content: "Hello agent" },
    });

    const own = await call("GET", `/api/v1/agent/conversations/${conversation.id}`, {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(own.status).toBe(200);
    const transcript = (await own.json()) as {
      conversation: AgentConversation;
      messages: AgentMessage[];
      actions: unknown[];
    };
    expect(transcript.conversation.id).toBe(conversation.id);
    expect(transcript.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const foreign = await call("GET", `/api/v1/agent/conversations/${conversation.id}`, {
      role: UserRole.ADMIN,
      userId: otherAdminId,
    });
    expect(foreign.status).toBe(404);

    const missing = await call("GET", "/api/v1/agent/conversations/does-not-exist", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(missing.status).toBe(404);
  });

  // --- turns ----------------------------------------------------------------

  test("POST a turn: 200 with the turn's messages; the conversation gets its title", async () => {
    const conversation = await createConversation(adminId);
    const res = await call("POST", `/api/v1/agent/conversations/${conversation.id}/turns`, {
      role: UserRole.ADMIN,
      userId: adminId,
      body: { content: "How many vehicles do I have?" },
    });
    expect(res.status).toBe(200);
    const turn = (await res.json()) as {
      conversation: AgentConversation;
      messages: AgentMessage[];
      actions: unknown[];
    };
    expect(turn.conversation.title).toBe("How many vehicles do I have?");
    expect(turn.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // The mock's default reply — proof the wire ran the LLM seam, no network.
    expect(turn.messages[1]?.content).toContain("MockLlmClient");
    expect(turn.actions).toEqual([]);
  });

  test("turn body validation: empty content, unknown keys, oversize → 400; missing conversation → 404", async () => {
    const conversation = await createConversation(adminId);
    const turnPath = `/api/v1/agent/conversations/${conversation.id}/turns`;
    const asAdmin = { role: UserRole.ADMIN, userId: adminId };

    expect((await call("POST", turnPath, { ...asAdmin, body: { content: "  " } })).status).toBe(
      400,
    );
    expect(
      (await call("POST", turnPath, { ...asAdmin, body: { content: "hi", role: "system" } }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", turnPath, { ...asAdmin, body: { content: "x".repeat(8_001) } })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/v1/agent/conversations/does-not-exist/turns", {
          ...asAdmin,
          body: { content: "hi" },
        })
      ).status,
    ).toBe(404);
  });

  // --- activity ledger (A8) -------------------------------------------------

  interface ActionsResponse {
    items: {
      id: string;
      toolName: string;
      status: string;
      argsJson: unknown;
      previousJson: unknown;
      user: { id: string; email: string; name: string | null };
    }[];
    total: number;
    skip: number;
    take: number;
    sortBy: string;
    sortDir: string;
  }

  test("the activity ledger rides the agent:use gate: 401 / 403 / 403 / 200", async () => {
    expect((await call("GET", "/api/v1/agent/actions")).status).toBe(401);
    expect(
      (await call("GET", "/api/v1/agent/actions", { role: UserRole.OFFICE_STAFF })).status,
    ).toBe(403);
    expect((await call("GET", "/api/v1/agent/actions", { role: UserRole.DRIVER })).status).toBe(
      403,
    );
    expect(
      (await call("GET", "/api/v1/agent/actions", { role: UserRole.ADMIN, userId: adminId }))
        .status,
    ).toBe(200);
  });

  test("the ledger is CROSS-USER: both admins' actions are listed, with the acting user and args", async () => {
    await seedAgentAction(prisma, adminId, { toolName: "create_vehicle", status: "succeeded" });
    await seedAgentAction(prisma, otherAdminId, { toolName: "update_trip", status: "failed" });

    const res = await call("GET", "/api/v1/agent/actions", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionsResponse;

    expect(body.total).toBe(2);
    expect(body.sortBy).toBe("createdAt");
    expect(body.sortDir).toBe("desc");
    // The acting user rides each row (id/email/name only — never the auth row).
    const userIds = body.items.map((a) => a.user.id).sort();
    expect(userIds).toEqual([adminId, otherAdminId].sort());
    expect(body.items.every((a) => typeof a.user.email === "string")).toBe(true);
    // argsJson is on the wire to the authorized ADMIN.
    expect(body.items.every((a) => a.argsJson !== undefined)).toBe(true);
  });

  test("filters compose: toolName + status narrow the ledger", async () => {
    await seedAgentAction(prisma, adminId, { toolName: "create_vehicle", status: "succeeded" });
    await seedAgentAction(prisma, adminId, { toolName: "create_vehicle", status: "failed" });
    await seedAgentAction(prisma, adminId, { toolName: "update_trip", status: "succeeded" });

    const res = await call(
      "GET",
      "/api/v1/agent/actions?toolName=create_vehicle&status=succeeded",
      { role: UserRole.ADMIN, userId: adminId },
    );
    const body = (await res.json()) as ActionsResponse;
    expect(body.total).toBe(1);
    expect(body.items[0]?.toolName).toBe("create_vehicle");
    expect(body.items[0]?.status).toBe("succeeded");
  });

  test("an unknown status filter returns zero rows, never a 400 (the open-string rule)", async () => {
    await seedAgentAction(prisma, adminId, { status: "succeeded" });
    const res = await call("GET", "/api/v1/agent/actions?status=exploded", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ActionsResponse).total).toBe(0);
  });

  test("date range is inclusive through end-of-day; a row at 00:00 the next day is excluded", async () => {
    // Three rows across two calendar days; filter startDate=endDate=day one.
    await seedAgentAction(prisma, adminId, {
      toolName: "a",
      createdAt: new Date("2026-07-01T09:00:00Z"),
    });
    await seedAgentAction(prisma, adminId, {
      toolName: "b",
      createdAt: new Date("2026-07-01T23:59:59Z"),
    });
    await seedAgentAction(prisma, adminId, {
      toolName: "c",
      createdAt: new Date("2026-07-02T00:00:00Z"),
    });

    const res = await call("GET", "/api/v1/agent/actions?startDate=2026-07-01&endDate=2026-07-01", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    const body = (await res.json()) as ActionsResponse;
    // Both July-1 rows (incl. 23:59:59), NOT the July-2 00:00 row.
    expect(body.total).toBe(2);
    expect(body.items.map((a) => a.toolName).sort()).toEqual(["a", "b"]);
  });

  test("pagination is stable (createdAt + id tiebreaker) and a bogus query key → 400", async () => {
    const sharedTime = new Date("2026-07-01T12:00:00Z");
    for (let i = 0; i < 3; i += 1) {
      await seedAgentAction(prisma, adminId, { toolName: `t${i}`, createdAt: sharedTime });
    }
    const page1 = (await (
      await call("GET", "/api/v1/agent/actions?take=2&skip=0", {
        role: UserRole.ADMIN,
        userId: adminId,
      })
    ).json()) as ActionsResponse;
    const page2 = (await (
      await call("GET", "/api/v1/agent/actions?take=2&skip=2", {
        role: UserRole.ADMIN,
        userId: adminId,
      })
    ).json()) as ActionsResponse;
    // No row appears on both pages — the id tiebreaker makes equal-createdAt
    // ordering deterministic.
    const ids = [...page1.items, ...page2.items].map((a) => a.id);
    expect(new Set(ids).size).toBe(3);

    const bad = await call("GET", "/api/v1/agent/actions?sort=asc", {
      role: UserRole.ADMIN,
      userId: adminId,
    });
    expect(bad.status).toBe(400);
  });
});
