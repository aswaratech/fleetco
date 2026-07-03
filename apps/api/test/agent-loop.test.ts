import { ConflictException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  AgentService,
  buildAgentSystemPrompt,
  deriveConversationTitle,
  CONVERSATION_TITLE_MAX_LENGTH,
  DEFAULT_AGENT_TURN_BUDGETS,
} from "../src/modules/agent/agent.service";
import {
  LlmCallError,
  LlmClient,
  type LlmCompletionResult,
  type LlmMessage,
} from "../src/modules/agent/llm-client";
import { MockLlmClient } from "../src/modules/agent/mock-llm.client";
import { AgentToolRegistry } from "../src/modules/agent/tools/tool-registry";
import { type Actor, DriverScopeService } from "../src/modules/auth/driver-scope.service";
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
import { seedDriver, seedTrip, seedUser, seedVehicle } from "./fixtures/trip";

// The agent turn loop end-to-end (ADR-0043 c4/c5, ticket A5): a REAL
// AgentToolRegistry over real Postgres, driven by MockLlmClient's result
// QUEUE — the multi-round tool-loop capability A3 built the queue for. Every
// c4d budget, the c5 persistence writes, and the c1 identity threading are
// pinned here at the service layer; the HTTP surface (guards, agent:use,
// wire validation) is pinned in agent-endpoints.test.ts.

// --- result builders -------------------------------------------------------

function textResult(content: string, usage?: LlmCompletionResult["usage"]): LlmCompletionResult {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    ...(usage !== undefined ? { usage } : {}),
  };
}

function toolCallsResult(
  calls: { id: string; name: string; args?: unknown; rawArgs?: string }[],
  content: string | null = null,
): LlmCompletionResult {
  return {
    message: {
      role: "assistant",
      content,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: call.rawArgs ?? JSON.stringify(call.args ?? {}),
        },
      })),
    },
    finishReason: "tool_calls",
  };
}

/** An LlmClient that hangs until the caller's abort signal fires — the shape
 * of a stalled provider, for the turn wall-clock test. */
class HangingLlm extends LlmClient {
  complete(_request: unknown, opts?: { signal?: AbortSignal }): Promise<LlmCompletionResult> {
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new LlmCallError("aborted")), {
        once: true,
      });
    });
  }
}

/** An LlmClient whose completions resolve only when the test says so — for
 * holding a turn in flight while asserting the per-conversation lock. */
class DeferredLlm extends LlmClient {
  readonly resolvers: ((result: LlmCompletionResult) => void)[] = [];

  complete(): Promise<LlmCompletionResult> {
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// --- pure helpers ----------------------------------------------------------

describe("deriveConversationTitle (c5: title from the first user message)", () => {
  test("collapses whitespace and passes short content through", () => {
    expect(deriveConversationTitle("  How many\n\n trips  this week? ")).toBe(
      "How many trips this week?",
    );
  });

  test("truncates to the max length with an ellipsis", () => {
    const long = "x".repeat(200);
    const title = deriveConversationTitle(long);
    expect(title).toHaveLength(CONVERSATION_TITLE_MAX_LENGTH);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("buildAgentSystemPrompt (c4e)", () => {
  test("carries the id rule, the link rule, the units, and the current date", () => {
    const prompt = buildAgentSystemPrompt(new Date("2026-07-02T10:00:00Z"));
    expect(prompt).toContain("Never guess or fabricate an entity id");
    expect(prompt).toContain("/vehicles/<id>");
    expect(prompt).toContain("integer paisa");
    expect(prompt).toContain("2026-07-02");
  });
});

// --- the loop over real registry + DB ---------------------------------------

describe("agent turn loop (real registry + Postgres, MockLlmClient queue)", () => {
  let prisma: PrismaService;
  let registry: AgentToolRegistry;

  let adminId: string;
  let admin: Actor;

  function serviceWith(
    llm: LlmClient,
    budgets: Partial<typeof DEFAULT_AGENT_TURN_BUDGETS> = {},
  ): AgentService {
    return new AgentService(prisma, llm, registry, {
      ...DEFAULT_AGENT_TURN_BUDGETS,
      ...budgets,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
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
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    registry = moduleRef.get(AgentToolRegistry);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = await seedUser(prisma, UserRole.ADMIN);
    admin = { userId: adminId, role: UserRole.ADMIN };
  });

  test("text-only turn: persists user + assistant with per-call usage, titles the conversation (c5/c8)", async () => {
    const mock = new MockLlmClient({
      results: [
        textResult("You have no vehicles yet.", {
          promptTokens: 120,
          completionTokens: 9,
          totalTokens: 129,
        }),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);
    expect(conversation.title).toBeNull();

    const turn = await service.runTurn(conversation.id, "How many vehicles do I have?", admin);

    expect(turn.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(turn.messages[0]?.content).toBe("How many vehicles do I have?");
    expect(turn.messages[0]?.promptTokens).toBeNull(); // no LLM call behind the user's row
    expect(turn.messages[1]?.content).toBe("You have no vehicles yet.");
    expect(turn.messages[1]?.promptTokens).toBe(120);
    expect(turn.messages[1]?.completionTokens).toBe(9);
    expect(turn.actions).toEqual([]);
    expect(turn.conversation.title).toBe("How many vehicles do I have?");

    // The request the provider saw: system prompt first, the user message
    // last, the capability-filtered tools attached, auto tool choice.
    const request = mock.requests[0];
    expect(request?.messages[0]?.role).toBe("system");
    expect(request?.messages.at(-1)).toEqual({
      role: "user",
      content: "How many vehicles do I have?",
    });
    expect(request?.tool_choice).toBe("auto");
    expect(request?.tools?.length).toBeGreaterThan(20); // the full ADMIN registry
  });

  test("message writes touch the conversation row — updatedAt is the prune basis (c5)", async () => {
    const service = serviceWith(new MockLlmClient({ results: [textResult("Reply.")] }));
    const conversation = await service.createConversation(admin);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const turn = await service.runTurn(conversation.id, "Hello", admin);

    expect(turn.conversation.updatedAt.getTime()).toBeGreaterThan(conversation.updatedAt.getTime());
  });

  test("tool loop: dispatches through the registry, round-trips the result, records the action (c4/c5)", async () => {
    await seedVehicle(prisma, adminId);
    await seedVehicle(prisma, adminId);
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "list_vehicles", args: {} }]),
        textResult("You have 2 vehicles."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "List my vehicles", admin);

    // Persistence: user row, the tool_calls round's assistant row (empty
    // content), the final assistant row.
    expect(turn.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(turn.messages[1]?.content).toBe("");
    expect(turn.messages[2]?.content).toBe("You have 2 vehicles.");

    // The AgentAction row (c5): every field the audit spine needs, linked to
    // the assistant message whose tool_calls produced it.
    expect(turn.actions).toHaveLength(1);
    const action = turn.actions[0];
    expect(action?.toolName).toBe("list_vehicles");
    expect(action?.status).toBe("succeeded");
    expect(action?.argsJson).toEqual({});
    expect(action?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(action?.userId).toBe(adminId);
    expect(action?.conversationId).toBe(conversation.id);
    expect(action?.messageId).toBe(turn.messages[1]?.id);
    // Stage one (reads): no single entity is affected.
    expect(action?.resultEntityType).toBeNull();
    expect(action?.resultEntityId).toBeNull();

    // The second LLM round saw the assistant tool_calls message VERBATIM
    // (snake_case round-trip) plus a tool-role reply for its call id.
    expect(mock.requests).toHaveLength(2);
    const secondRequest = mock.requests[1];
    const assistantMessage = secondRequest?.messages.find(
      (m) => m.role === "assistant" && m.tool_calls !== undefined,
    );
    expect(assistantMessage?.tool_calls?.[0]?.id).toBe("call_1");
    expect(assistantMessage?.tool_calls?.[0]?.function.name).toBe("list_vehicles");
    const toolMessage = secondRequest?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call_1");
    const payload = JSON.parse(toolMessage?.content ?? "") as { total: number };
    expect(payload.total).toBe(2);
  });

  test("the tool-result string that crosses to the provider is REDACTED (c6)", async () => {
    const vehicle = await seedVehicle(prisma, adminId);
    const driver = await seedDriver(prisma, adminId, {
      licenseNumber: "12-345-6789",
      dateOfBirth: new Date("1990-01-01T00:00:00Z"),
    });
    const trip = await seedTrip(prisma, {
      vehicleId: vehicle.id,
      driverId: driver.id,
      createdById: adminId,
    });
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "get_trip", args: { id: trip.id } }]),
        textResult("Found it."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    await service.runTurn(conversation.id, "Show that trip", admin);

    const toolMessage = mock.requests[1]?.messages.find((m) => m.role === "tool");
    const payload = JSON.parse(toolMessage?.content ?? "") as {
      driver: Record<string, unknown>;
    };
    expect("dateOfBirth" in payload.driver).toBe(false);
    expect(payload.driver.licenseNumber).toBe("***6789");
  });

  test("failed tool call records status=failed and the loop continues with the error (c5)", async () => {
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "get_vehicle", args: { id: "no-such-id" } }]),
        textResult("That vehicle does not exist."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Show vehicle no-such-id", admin);

    expect(turn.actions).toHaveLength(1);
    expect(turn.actions[0]?.status).toBe("failed");
    expect(turn.actions[0]?.argsJson).toEqual({ id: "no-such-id" });
    const toolMessage = mock.requests[1]?.messages.find((m) => m.role === "tool");
    const payload = JSON.parse(toolMessage?.content ?? "") as { error: string };
    expect(payload.error).toContain("no-such-id");
    expect(turn.messages.at(-1)?.content).toBe("That vehicle does not exist.");
  });

  test("capability-denied tool call records status=denied; the model never saw the tool (c1)", async () => {
    // agent:use is the ROUTE gate (ADMIN-only, pinned in the endpoints
    // test); the loop itself runs as whatever actor the controller threads.
    // A DRIVER actor here proves the registry's per-tool capability floor
    // holds even for a hallucinated tool the filtered spec list never
    // offered.
    const driverUserId = await seedUser(prisma, UserRole.DRIVER);
    await seedDriver(prisma, adminId, { userId: driverUserId });
    const driverActor: Actor = { userId: driverUserId, role: UserRole.DRIVER };
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "list_customers", args: {} }]),
        textResult("I cannot access customers."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(driverActor);

    const turn = await service.runTurn(conversation.id, "List customers", driverActor);

    expect(turn.actions[0]?.status).toBe("denied");
    expect(turn.actions[0]?.userId).toBe(driverUserId);
    // The capability filter had already hidden the tool from the spec list.
    const offered = mock.requests[0]?.tools?.map((t) => t.function.name) ?? [];
    expect(offered).not.toContain("list_customers");
  });

  test("unknown tool records status=failed and the turn recovers (hallucinated name)", async () => {
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "delete_everything", args: {} }]),
        textResult("No such tool exists."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Delete everything", admin);

    expect(turn.actions[0]?.toolName).toBe("delete_everything");
    expect(turn.actions[0]?.status).toBe("failed");
    expect(turn.messages.at(-1)?.content).toBe("No such tool exists.");
  });

  test("non-JSON tool arguments record status=failed without dispatching", async () => {
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "list_vehicles", rawArgs: "{not json" }]),
        textResult("Let me try again."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "List vehicles", admin);

    expect(turn.actions[0]?.status).toBe("failed");
    const toolMessage = mock.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("not valid JSON");
  });

  test("round budget (c4d): stops after maxLlmRounds with a system notice; no further LLM call", async () => {
    // Every round asks for another tool call; the queue holds MORE results
    // than the budget so only the budget can stop the loop.
    const results = Array.from({ length: 10 }, (_, i) =>
      toolCallsResult([{ id: `call_${i}`, name: "list_vehicles", args: {} }]),
    );
    const mock = new MockLlmClient({ results });
    const service = serviceWith(mock, { maxLlmRounds: 3 });
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Keep listing", admin);

    expect(mock.requests).toHaveLength(3);
    expect(turn.actions).toHaveLength(3);
    const notice = turn.messages.at(-1);
    expect(notice?.role).toBe("system");
    expect(notice?.content).toContain("3-round budget");
  });

  test("tool-execution budget (c4d): the excess call is denied-not-run and the turn stops", async () => {
    const batch = (round: number, count: number) =>
      toolCallsResult(
        Array.from({ length: count }, (_, i) => ({
          id: `call_${round}_${i}`,
          name: "list_vehicles",
          args: {},
        })),
      );
    const mock = new MockLlmClient({ results: [batch(1, 3), batch(2, 2)] });
    const service = serviceWith(mock, { maxToolExecutions: 4 });
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Do a lot", admin);

    // 4 executed within budget, the 5th recorded as denied without running.
    expect(turn.actions).toHaveLength(5);
    expect(turn.actions.filter((a) => a.status === "succeeded")).toHaveLength(4);
    expect(turn.actions.at(-1)?.status).toBe("denied");
    expect(mock.requests).toHaveLength(2); // no third round
    const notice = turn.messages.at(-1);
    expect(notice?.role).toBe("system");
    expect(notice?.content).toContain("4-tool-execution budget");
    // The refused dispatch never ran: its latency is ~0 and its row still
    // carries the attempted args (the audit spine has no silent paths).
    expect(turn.actions.at(-1)?.latencyMs).toBeLessThanOrEqual(1);
    expect(turn.actions.at(-1)?.argsJson).toEqual({});
  });

  test("turn wall clock (c4d): a hung provider call aborts and the turn ends with a notice", async () => {
    const service = serviceWith(new HangingLlm(), { turnWallClockMs: 50 });
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Hello?", admin);

    expect(turn.messages.map((m) => m.role)).toEqual(["user", "system"]);
    expect(turn.messages.at(-1)?.content).toContain("time budget");
  });

  test("provider failure ends the turn with a PII-free system notice, not an exception", async () => {
    const mock = new MockLlmClient({
      throwError: new LlmCallError("http_500", { status: 500 }),
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Hello?", admin);

    const notice = turn.messages.at(-1);
    expect(notice?.role).toBe("system");
    expect(notice?.content).toContain("http_500");
    // The user's message survived the failure — the transcript explains itself.
    expect(turn.messages[0]?.role).toBe("user");
  });

  test("in-flight lock (c4d): a concurrent turn on the SAME conversation → 409; another conversation proceeds", async () => {
    const deferred = new DeferredLlm();
    const service = serviceWith(deferred);
    const conversationA = await service.createConversation(admin);
    const conversationB = await service.createConversation(admin);

    const firstTurn = service.runTurn(conversationA.id, "Turn one", admin);
    await waitUntil(() => deferred.resolvers.length === 1);

    // Same conversation, while in flight: 409 (a retry cannot fork two loops).
    await expect(service.runTurn(conversationA.id, "Turn two", admin)).rejects.toThrow(
      ConflictException,
    );

    // A DIFFERENT conversation is not blocked — the lock is per-conversation.
    const otherTurn = service.runTurn(conversationB.id, "Other conversation", admin);
    await waitUntil(() => deferred.resolvers.length === 2);

    deferred.resolvers[0]?.(textResult("Done A."));
    deferred.resolvers[1]?.(textResult("Done B."));
    const [turnA, turnB] = await Promise.all([firstTurn, otherTurn]);
    expect(turnA.messages.at(-1)?.content).toBe("Done A.");
    expect(turnB.messages.at(-1)?.content).toBe("Done B.");

    // The lock released: the same conversation accepts the next turn.
    const nextService = serviceWith(new MockLlmClient({ results: [textResult("Again.")] }));
    const next = await nextService.runTurn(conversationA.id, "Turn three", admin);
    expect(next.messages.at(-1)?.content).toBe("Again.");
  });

  test("follow-up turn rebuilds context from TEXT messages only; the title stays (c5)", async () => {
    await seedVehicle(prisma, adminId);
    const mockTurn1 = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "list_vehicles", args: {} }]),
        textResult("You have 1 vehicle."),
      ],
    });
    const service1 = serviceWith(mockTurn1);
    const conversation = await service1.createConversation(admin);
    await service1.runTurn(conversation.id, "How many vehicles?", admin);

    const mockTurn2 = new MockLlmClient({ results: [textResult("Still 1.")] });
    const service2 = serviceWith(mockTurn2);
    const turn2 = await service2.runTurn(conversation.id, "And now?", admin);

    const request = mockTurn2.requests[0];
    const roles = request?.messages.map((m) => m.role);
    // system + turn-1 user + turn-1 FINAL assistant text + turn-2 user. The
    // tool_calls-only assistant row (empty content) and the tool exchange are
    // NOT replayed across turns.
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    expect(request?.messages.some((m: LlmMessage) => m.tool_calls !== undefined)).toBe(false);
    expect(request?.messages[2]?.content).toBe("You have 1 vehicle.");

    // Title derived from the FIRST user message only.
    expect(turn2.conversation.title).toBe("How many vehicles?");
  });

  test("ownership: a foreign conversation 404s on runTurn and getTranscript", async () => {
    const otherAdminId = await seedUser(prisma, UserRole.ADMIN);
    const other: Actor = { userId: otherAdminId, role: UserRole.ADMIN };
    const service = serviceWith(new MockLlmClient());
    const conversation = await service.createConversation(admin);

    await expect(service.runTurn(conversation.id, "Hi", other)).rejects.toThrow(NotFoundException);
    await expect(service.getTranscript(conversation.id, other)).rejects.toThrow(NotFoundException);
  });

  test("getTranscript returns the stored messages and actions in insertion order", async () => {
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([{ id: "call_1", name: "list_vehicles", args: {} }]),
        textResult("None found."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);
    await service.runTurn(conversation.id, "List vehicles", admin);

    const transcript = await service.getTranscript(conversation.id, admin);

    expect(transcript.conversation.id).toBe(conversation.id);
    expect(transcript.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(transcript.actions).toHaveLength(1);
    expect(transcript.actions[0]?.toolName).toBe("list_vehicles");
  });

  test("listConversations returns only the actor's own, most recently active first", async () => {
    const otherAdminId = await seedUser(prisma, UserRole.ADMIN);
    const other: Actor = { userId: otherAdminId, role: UserRole.ADMIN };
    const service = serviceWith(new MockLlmClient());
    const mineOld = await service.createConversation(admin);
    await service.createConversation(other);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const mineNew = await service.createConversation(admin);

    const { items, total } = await service.listConversations(admin, { skip: 0, take: 50 });

    expect(total).toBe(2);
    expect(items.map((c) => c.id)).toEqual([mineNew.id, mineOld.id]);
  });

  // --- stage two: write dispatches through the loop (A7) ---------------------

  test("a write turn records the affected entity on the action row (c4c/c5)", async () => {
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([
          {
            id: "call_1",
            name: "create_vehicle",
            args: {
              registrationNumber: "BA 3 KHA 7777",
              kind: "TRUCK",
              make: "Tata",
              model: "LPT 1613",
              year: 2023,
              acquiredAt: "2026-02-01",
            },
          },
        ]),
        textResult("Registered BA 3 KHA 7777 — see /vehicles/<id>."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Register BA 3 KHA 7777", admin);

    const created = await prisma.vehicle.findUniqueOrThrow({
      where: { registrationNumber: "BA 3 KHA 7777" },
    });
    expect(created.createdById).toBe(adminId);

    expect(turn.actions).toHaveLength(1);
    const action = turn.actions[0];
    expect(action?.toolName).toBe("create_vehicle");
    expect(action?.status).toBe("succeeded");
    expect(action?.resultEntityType).toBe("Vehicle");
    expect(action?.resultEntityId).toBe(created.id);

    // The tool message the provider saw carries the REDACTED result — with
    // the created row's id, so the model can state the app path (c4e).
    const toolMessage = mock.requests[1]?.messages.find((m) => m.role === "tool");
    const payload = JSON.parse(toolMessage?.content ?? "") as { id: string };
    expect(payload.id).toBe(created.id);
  });

  test("a failed write records failed with NULL entity fields (nothing was affected)", async () => {
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([
          {
            id: "call_1",
            name: "create_job",
            // A cuid-shaped customerId that exists nowhere: the module
            // schema passes, the FK insert fails (P2003 → 400).
            args: { customerId: "c00000000000000000000000", description: "Haul gravel" },
          },
        ]),
        textResult("That customer does not exist."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Create a job for them", admin);

    expect(turn.actions).toHaveLength(1);
    expect(turn.actions[0]?.status).toBe("failed");
    expect(turn.actions[0]?.resultEntityType).toBeNull();
    expect(turn.actions[0]?.resultEntityId).toBeNull();
    expect(await prisma.job.count()).toBe(0);
  });

  // --- stage two: update pre-image through the loop (A8) --------------------

  test("a succeeded update persists previousJson; the provider never saw the pre-image (c4b/c6)", async () => {
    const vehicle = await seedVehicle(prisma, adminId, { odometerCurrentKm: 8_000 });
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([
          {
            id: "call_1",
            name: "update_vehicle",
            args: { id: vehicle.id, odometerCurrentKm: 8_250 },
          },
        ]),
        textResult("Updated the odometer — see /vehicles/<id>."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Set the odometer to 8250", admin);

    expect(turn.actions).toHaveLength(1);
    const action = turn.actions[0];
    expect(action?.status).toBe("succeeded");
    expect(action?.resultEntityType).toBe("Vehicle");
    // The pre-image (prior odometer 8000) persisted on the audit row, raw.
    const pre = action?.previousJson as { odometerCurrentKm: number };
    expect(pre.odometerCurrentKm).toBe(8_000);

    // The tool message the provider saw carries the REDACTED RESULT (new
    // value) — and NOT the pre-image content (odometer 8000 must not appear
    // as a "previousJson" the model could read).
    const toolMessage = mock.requests[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).not.toContain("previousJson");
    const payload = JSON.parse(toolMessage?.content ?? "") as { odometerCurrentKm: number };
    expect(payload.odometerCurrentKm).toBe(8_250);
  });

  test("a failed update records failed with previousJson NULL (nothing changed, nothing to undo)", async () => {
    const mock = new MockLlmClient({
      results: [
        toolCallsResult([
          {
            id: "call_1",
            name: "update_vehicle",
            args: { id: "c00000000000000000000000", make: "Ghost" },
          },
        ]),
        textResult("That vehicle does not exist."),
      ],
    });
    const service = serviceWith(mock);
    const conversation = await service.createConversation(admin);

    const turn = await service.runTurn(conversation.id, "Rename a vehicle", admin);

    expect(turn.actions[0]?.status).toBe("failed");
    expect(turn.actions[0]?.previousJson).toBeNull();
    expect(turn.actions[0]?.resultEntityType).toBeNull();
  });
});
