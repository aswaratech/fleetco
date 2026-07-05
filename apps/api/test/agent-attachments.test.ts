import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import { type NestExpressApplication } from "@nestjs/platform-express";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AgentController } from "../src/modules/agent/agent.controller";
import {
  AgentAttachmentsService,
  MAX_ATTACHMENT_BYTES,
  sniffImageType,
} from "../src/modules/agent/agent-attachments.service";
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
import { seedAgentConversation } from "./fixtures/agent-transcript";
import { seedUser } from "./fixtures/trip";

// The attachment upload/serve endpoints (ADR-0044 c3, ticket V4), over the
// agent-endpoints harness — with one deliberate difference: the app is
// created with `bodyParser: false` + the same useBodyParser re-attach
// main.ts performs, so THIS suite pins the production body-parser × multer
// interaction (multipart must pass through untouched for FileInterceptor to
// consume; ADR-0021's raw-body arrangement must not break it).

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

// A real 1×1 PNG (signature + valid structure) — the smallest honest image.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// JPEG magic prefix on an otherwise-arbitrary body (the sniff reads bytes,
// not structure — decoding is the extractor's concern, not upload's).
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fleetco")]);

describe("agent attachment endpoints (real guards + Postgres + mock storage, ADR-0044 V4)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  const storage = new MockObjectStorage();

  let adminId: string;
  let otherAdminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        AgentService,
        AgentAttachmentsService,
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
        { provide: LlmClient, useValue: new MockLlmClient() },
        { provide: ObjectStorage, useValue: storage },
        { provide: VisionExtractor, useValue: new MockVisionExtractor() },
      ],
    }).compile();

    // The main.ts arrangement, replicated: no automatic parsers, json +
    // urlencoded re-attached — multipart flows raw to multer.
    app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
      bodyParser: false,
    });
    app.useBodyParser("json");
    app.useBodyParser("urlencoded", { extended: true });
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
    storage.puts.length = 0;
    storage.deletes.length = 0;
    await resetDb(prisma);
    adminId = await seedUser(prisma, UserRole.ADMIN);
    otherAdminId = await seedUser(prisma, UserRole.ADMIN);
  });

  function upload(
    conversationId: string,
    bytes: Buffer,
    opts: { role?: UserRole | null; userId?: string; omitFile?: boolean } = {},
  ): Promise<Response> {
    const form = new FormData();
    if (opts.omitFile !== true) {
      form.append("file", new Blob([new Uint8Array(bytes)]), "photo.bin");
    }
    const headers: Record<string, string> = {};
    if (opts.role !== null) {
      headers["x-test-role"] = opts.role ?? UserRole.ADMIN;
      headers["x-test-user"] = opts.userId ?? adminId;
    }
    return fetch(`${baseUrl}/api/v1/agent/conversations/${conversationId}/attachments`, {
      method: "POST",
      headers,
      body: form,
    });
  }

  test("sniffImageType recognizes exactly the three allowlisted signatures", () => {
    expect(sniffImageType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageType(Buffer.concat([Buffer.from("RIFF1234"), Buffer.from("WEBPrest")]))).toBe(
      "image/webp",
    );
    expect(sniffImageType(Buffer.from("plain text pretending to be a photo"))).toBeNull();
  });

  test("anonymous → 401; OFFICE_STAFF → 403 (the class-level agent:use gate)", async () => {
    const conversation = await seedAgentConversation(prisma, adminId);
    expect((await upload(conversation.id, PNG_BYTES, { role: null })).status).toBe(401);
    expect((await upload(conversation.id, PNG_BYTES, { role: UserRole.OFFICE_STAFF })).status).toBe(
      403,
    );
  });

  test("uploads a PNG: 201, sniffed type, sha256, stored through the seam, row unclaimed", async () => {
    const conversation = await seedAgentConversation(prisma, adminId);

    const response = await upload(conversation.id, PNG_BYTES);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      id: string;
      conversationId: string;
      messageId: string | null;
      contentType: string;
      sizeBytes: number;
      sha256: string;
      r2Key: string;
    };

    expect(body.conversationId).toBe(conversation.id);
    expect(body.messageId).toBeNull(); // pending until a turn claims it (V7)
    expect(body.contentType).toBe("image/png"); // sniffed, not asserted
    expect(body.sizeBytes).toBe(PNG_BYTES.length);
    expect(body.sha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
    expect(body.r2Key.startsWith(`agent-attachments/${conversation.id}/`)).toBe(true);
    expect(body.r2Key.endsWith(".png")).toBe(true);

    // The bytes went through the ObjectStorage seam with the sniffed type.
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]?.key).toBe(body.r2Key);
    expect(storage.puts[0]?.contentType).toBe("image/png");
    expect(storage.puts[0]?.body.equals(PNG_BYTES)).toBe(true);
  });

  test("a non-image body → 400 naming the allowlist; nothing stored", async () => {
    const conversation = await seedAgentConversation(prisma, adminId);
    const response = await upload(conversation.id, Buffer.from("not an image at all"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toContain("JPEG, PNG, or WEBP");
    expect(storage.puts).toHaveLength(0);
    expect(await prisma.agentAttachment.count()).toBe(0);
  });

  test("a missing file part → 400", async () => {
    const conversation = await seedAgentConversation(prisma, adminId);
    const response = await upload(conversation.id, PNG_BYTES, { omitFile: true });
    expect(response.status).toBe(400);
  });

  test("a foreign conversation → 404 (existence-hiding)", async () => {
    const foreign = await seedAgentConversation(prisma, otherAdminId);
    const response = await upload(foreign.id, PNG_BYTES);
    expect(response.status).toBe(404);
  });

  test("a stream past 10 MB → 413 (multer's limit fires before buffering completes)", async () => {
    const conversation = await seedAgentConversation(prisma, adminId);
    const oversized = Buffer.concat([JPEG_BYTES, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    const response = await upload(conversation.id, oversized);
    expect(response.status).toBe(413);
    expect(storage.puts).toHaveLength(0);
  });

  test("GET streams the owner's bytes inline with the sniffed content type; foreign → 404", async () => {
    const conversation = await seedAgentConversation(prisma, adminId);
    const uploaded = (await (await upload(conversation.id, JPEG_BYTES)).json()) as { id: string };

    const ok = await fetch(`${baseUrl}/api/v1/agent/attachments/${uploaded.id}`, {
      headers: { "x-test-role": UserRole.ADMIN, "x-test-user": adminId },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("image/jpeg");
    expect(ok.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await ok.arrayBuffer()).equals(JPEG_BYTES)).toBe(true);

    const foreign = await fetch(`${baseUrl}/api/v1/agent/attachments/${uploaded.id}`, {
      headers: { "x-test-role": UserRole.ADMIN, "x-test-user": otherAdminId },
    });
    expect(foreign.status).toBe(404);
  });
});
