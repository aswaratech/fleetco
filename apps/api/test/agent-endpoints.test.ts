import type { AddressInfo } from "node:net";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole, type AgentConversation, type AgentMessage } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AgentController } from "../src/modules/agent/agent.controller";
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
import { TripsService } from "../src/modules/trips/trips.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { resetDb } from "./db";
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
});
