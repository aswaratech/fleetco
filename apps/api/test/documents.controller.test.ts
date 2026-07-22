import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import { type NestExpressApplication } from "@nestjs/platform-express";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { DocumentsController } from "../src/modules/documents/documents.controller";
import { DocumentsService } from "../src/modules/documents/documents.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { MockObjectStorage } from "../src/modules/storage/mock.object-storage";
import { ObjectStorage } from "../src/modules/storage/object-storage";
import { resetDb } from "./db";
import { seedCustomer } from "./fixtures/agent";
import { seedDriver, seedUser, seedVehicle } from "./fixtures/trip";

// HTTP-boundary tests for the FleetDocument endpoints (ADR-0049 F2) over the
// real AuthGuard + RolesGuard chain, real Postgres, and the mock storage seam
// — the agent-attachments harness shape, including the production body-parser
// arrangement (bodyParser:false + json/urlencoded re-attach) so multipart
// flows raw to multer. The privilege design under test (c6): documents:read /
// documents:write are operational floor (ADMIN + OFFICE_STAFF), while DELETE
// is ADMIN-only via documents:delete; DRIVER holds none of the three.

const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
      const userId = headers.get("x-test-user") ?? "user_docs_admin";
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

const PDF_BYTES = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("fleetco policy")]);
const TEXT_BYTES = Buffer.from("not a document at all");

interface DocumentBody {
  id: string;
  entityType: string;
  contentType: string;
  category: string;
  title: string;
  r2Key: string;
}

describe("documents endpoints (real guards + Postgres + mock storage, ADR-0049 F2)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let prisma: PrismaService;
  const storage = new MockObjectStorage();

  let adminId: string;
  let vehicleId: string;
  let driverRowId: string;
  let customerId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [
        DocumentsService,
        PrismaService,
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        { provide: ObjectStorage, useValue: storage },
      ],
    }).compile();

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
    vehicleId = (await seedVehicle(prisma, adminId)).id;
    driverRowId = (await seedDriver(prisma, adminId)).id;
    customerId = (await seedCustomer(prisma, adminId)).id;
  });

  function authHeaders(role: UserRole | null): Record<string, string> {
    if (role === null) return {};
    return { "x-test-role": role, "x-test-user": adminId };
  }

  function upload(
    fields: Record<string, string>,
    bytes: Buffer | null,
    role: UserRole | null = UserRole.ADMIN,
  ): Promise<Response> {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (bytes !== null) {
      form.append("file", new Blob([new Uint8Array(bytes)]), "document.bin");
    }
    return fetch(`${baseUrl}/api/v1/documents`, {
      method: "POST",
      headers: authHeaders(role),
      body: form,
    });
  }

  async function uploadedDocument(fields?: Record<string, string>): Promise<DocumentBody> {
    const response = await upload(
      fields ?? { vehicleId, category: "BLUEBOOK", title: "Bluebook scan" },
      PDF_BYTES,
    );
    expect(response.status).toBe(201);
    return (await response.json()) as DocumentBody;
  }

  // -- the RBAC matrix over the composed chain -------------------------------

  test("anonymous → 401 on read, write, and delete", async () => {
    expect((await fetch(`${baseUrl}/api/v1/documents?vehicleId=${vehicleId}`)).status).toBe(401);
    expect(
      (await upload({ vehicleId, category: "OTHER", title: "x" }, PDF_BYTES, null)).status,
    ).toBe(401);
    expect(
      (await fetch(`${baseUrl}/api/v1/documents/c0000000000x`, { method: "DELETE" })).status,
    ).toBe(401);
  });

  test("DRIVER → 403 everywhere (holds none of the three tokens)", async () => {
    const headers = authHeaders(UserRole.DRIVER);
    expect(
      (await fetch(`${baseUrl}/api/v1/documents?vehicleId=${vehicleId}`, { headers })).status,
    ).toBe(403);
    expect(
      (await upload({ vehicleId, category: "OTHER", title: "x" }, PDF_BYTES, UserRole.DRIVER))
        .status,
    ).toBe(403);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/documents/c0000000000x`, {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(403);
  });

  test("OFFICE_STAFF uploads and reads (201/200) but cannot DELETE (403) — the c6 asymmetry", async () => {
    const created = await upload(
      { vehicleId, category: "INSURANCE", title: "Policy 2083" },
      PDF_BYTES,
      UserRole.OFFICE_STAFF,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as DocumentBody;

    const list = await fetch(`${baseUrl}/api/v1/documents?vehicleId=${vehicleId}`, {
      headers: authHeaders(UserRole.OFFICE_STAFF),
    });
    expect(list.status).toBe(200);

    const denied = await fetch(`${baseUrl}/api/v1/documents/${body.id}`, {
      method: "DELETE",
      headers: authHeaders(UserRole.OFFICE_STAFF),
    });
    expect(denied.status).toBe(403);

    const allowed = await fetch(`${baseUrl}/api/v1/documents/${body.id}`, {
      method: "DELETE",
      headers: authHeaders(UserRole.ADMIN),
    });
    expect(allowed.status).toBe(204);
    expect(storage.deletes).toContain(body.r2Key);
  });

  // -- upload contract -------------------------------------------------------

  test("uploads a PDF against each entity kind; the sniffed type rides the row", async () => {
    const vehicleDoc = await uploadedDocument();
    expect(vehicleDoc.entityType).toBe("VEHICLE");
    expect(vehicleDoc.contentType).toBe("application/pdf");

    const driverDoc = await uploadedDocument({
      driverId: driverRowId,
      category: "LICENSE",
      title: "License scan",
    });
    expect(driverDoc.entityType).toBe("DRIVER");

    const customerDoc = await uploadedDocument({
      customerId,
      category: "AGREEMENT",
      title: "Haul contract",
      expiresAt: "2027-01-15",
    });
    expect(customerDoc.entityType).toBe("CUSTOMER");
  });

  test("rejects a missing file part, unrecognized bytes, and a category outside the entity's matrix (400)", async () => {
    expect((await upload({ vehicleId, category: "OTHER", title: "x" }, null)).status).toBe(400);
    expect((await upload({ vehicleId, category: "OTHER", title: "x" }, TEXT_BYTES)).status).toBe(
      400,
    );
    expect(
      (await upload({ vehicleId, category: "LICENSE", title: "wrong" }, PDF_BYTES)).status,
    ).toBe(400);
  });

  test("rejects zero or two entity ids (400) and a ghost entity (404)", async () => {
    expect((await upload({ category: "OTHER", title: "x" }, PDF_BYTES)).status).toBe(400);
    expect(
      (await upload({ vehicleId, driverId: driverRowId, category: "OTHER", title: "x" }, PDF_BYTES))
        .status,
    ).toBe(400);
    expect(
      (await upload({ vehicleId: "c0000000ghost", category: "OTHER", title: "x" }, PDF_BYTES))
        .status,
    ).toBe(404);
  });

  test("rejects a stream past the 10 MB multer ceiling with 413", async () => {
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1, 0x25);
    const response = await upload({ vehicleId, category: "OTHER", title: "big" }, oversize);
    expect(response.status).toBe(413);
  });

  // -- reads -----------------------------------------------------------------

  test("list requires exactly one entity filter (400 without; 400 with two) and rejects unknown keys", async () => {
    const headers = authHeaders(UserRole.ADMIN);
    expect((await fetch(`${baseUrl}/api/v1/documents`, { headers })).status).toBe(400);
    expect(
      (
        await fetch(`${baseUrl}/api/v1/documents?vehicleId=${vehicleId}&driverId=${driverRowId}`, {
          headers,
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/v1/documents?vehicleId=${vehicleId}&bogus=1`, { headers }))
        .status,
    ).toBe(400);
  });

  test("list narrows by category; getById returns the row; an unknown id 404s", async () => {
    await uploadedDocument();
    const insurance = await uploadedDocument({
      vehicleId,
      category: "INSURANCE",
      title: "Policy",
    });

    const response = await fetch(
      `${baseUrl}/api/v1/documents?vehicleId=${vehicleId}&category=INSURANCE`,
      { headers: authHeaders(UserRole.ADMIN) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: DocumentBody[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(insurance.id);

    const byId = await fetch(`${baseUrl}/api/v1/documents/${insurance.id}`, {
      headers: authHeaders(UserRole.ADMIN),
    });
    expect(byId.status).toBe(200);

    const missing = await fetch(`${baseUrl}/api/v1/documents/c0000000gone`, {
      headers: authHeaders(UserRole.ADMIN),
    });
    expect(missing.status).toBe(404);
  });

  test("streams the stored bytes back inline with the sniffed content type", async () => {
    const document = await uploadedDocument();
    const response = await fetch(`${baseUrl}/api/v1/documents/${document.id}/content`, {
      headers: authHeaders(UserRole.OFFICE_STAFF),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    const returned = Buffer.from(await response.arrayBuffer());
    expect(returned.equals(PDF_BYTES)).toBe(true);
  });

  // -- PATCH -----------------------------------------------------------------

  test("PATCH edits metadata, rejects unknown keys, and re-checks the category matrix", async () => {
    const document = await uploadedDocument();
    const headers = { ...authHeaders(UserRole.OFFICE_STAFF), "content-type": "application/json" };

    const renamed = await fetch(`${baseUrl}/api/v1/documents/${document.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Bluebook 2083-84", expiresAt: "2027-03-01" }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as DocumentBody).title).toBe("Bluebook 2083-84");

    expect(
      (
        await fetch(`${baseUrl}/api/v1/documents/${document.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ vehicleId: "c0000000steal" }),
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await fetch(`${baseUrl}/api/v1/documents/${document.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ category: "ID_DOCUMENT" }),
        })
      ).status,
    ).toBe(400);
  });
});
