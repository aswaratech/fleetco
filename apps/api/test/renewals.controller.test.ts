import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import { type INestApplication } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { DocumentsService } from "../src/modules/documents/documents.service";
import { RenewalsController } from "../src/modules/vehicles/renewals.controller";
import { RenewalsService } from "../src/modules/vehicles/renewals.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { MockObjectStorage } from "../src/modules/storage/mock.object-storage";
import { ObjectStorage } from "../src/modules/storage/object-storage";
import { resetDb } from "./db";
import { seedUser, seedVehicle } from "./fixtures/trip";

// HTTP-boundary tests for the renewals endpoints (ADR-0049 F3) over the real
// AuthGuard + RolesGuard chain and real Postgres. The gate under test: the
// nested controller rides the class-level `vehicles:*` (operational floor —
// office staff already PATCH the same expiry fields), so DRIVER (which holds
// trips:*/fuel-logs:* but NOT vehicles:*) is 403 and anonymous is 401.

const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
      const userId = headers.get("x-test-user") ?? "user_renewals";
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

const OLD_EXPIRY = "2026-08-01T00:00:00.000Z";
const NEW_EXPIRY = "2027-08-01T00:00:00.000Z";

describe("renewals endpoints (real guards + Postgres, ADR-0049 F3)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let prisma: PrismaService;

  let adminId: string;
  let vehicleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RenewalsController],
      providers: [
        RenewalsService,
        DocumentsService,
        PrismaService,
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        { provide: ObjectStorage, useValue: new MockObjectStorage() },
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
    vehicleId = (await seedVehicle(prisma, adminId, { insuranceExpiresAt: new Date(OLD_EXPIRY) }))
      .id;
  });

  function post(
    body: unknown,
    role: UserRole | null = UserRole.ADMIN,
    vehicle: string = vehicleId,
  ): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (role !== null) {
      headers["x-test-role"] = role;
      headers["x-test-user"] = adminId;
    }
    return fetch(`${baseUrl}/api/v1/vehicles/${vehicle}/renewals`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  test("anonymous → 401; DRIVER → 403 (no vehicles:*); OFFICE_STAFF → 201 (operational floor)", async () => {
    const body = { kind: "INSURANCE", newExpiresAt: NEW_EXPIRY };
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, UserRole.DRIVER)).status).toBe(403);
    expect((await post(body, UserRole.OFFICE_STAFF)).status).toBe(201);
  });

  test("a renew round-trips: 201 with the snapshot, the vehicle updated, and the history lists it", async () => {
    const created = await post({
      kind: "INSURANCE",
      newExpiresAt: NEW_EXPIRY,
      insurer: "Neco Insurance",
      notes: "smoke",
    });
    expect(created.status).toBe(201);
    const record = (await created.json()) as {
      previousExpiresAt: string;
      newExpiresAt: string;
      kind: string;
    };
    expect(record.kind).toBe("INSURANCE");
    expect(record.previousExpiresAt).toBe(OLD_EXPIRY);
    expect(record.newExpiresAt).toBe(NEW_EXPIRY);

    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } });
    expect(vehicle.insuranceExpiresAt?.toISOString()).toBe(NEW_EXPIRY);
    expect(vehicle.insurer).toBe("Neco Insurance");

    const list = await fetch(`${baseUrl}/api/v1/vehicles/${vehicleId}/renewals`, {
      headers: { "x-test-role": UserRole.ADMIN, "x-test-user": adminId },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { total: number; items: { kind: string }[] };
    expect(listBody.total).toBe(1);
    expect(listBody.items[0].kind).toBe("INSURANCE");
  });

  test("the pipe rejects unknown keys, kind-foreign fields, a missing expiry, and a bogus kind (400)", async () => {
    expect((await post({ kind: "INSURANCE", newExpiresAt: NEW_EXPIRY, bogus: true })).status).toBe(
      400,
    );
    // insurer belongs to INSURANCE, not BLUEBOOK — the cross-field refine.
    expect(
      (await post({ kind: "BLUEBOOK", newExpiresAt: NEW_EXPIRY, insurer: "Neco" })).status,
    ).toBe(400);
    expect((await post({ kind: "INSURANCE" })).status).toBe(400);
    expect((await post({ kind: "MAINTENANCE", newExpiresAt: NEW_EXPIRY })).status).toBe(400);
  });

  test("a ghost vehicle 404s on both routes", async () => {
    expect(
      (await post({ kind: "INSURANCE", newExpiresAt: NEW_EXPIRY }, UserRole.ADMIN, "c000gone"))
        .status,
    ).toBe(404);
    const list = await fetch(`${baseUrl}/api/v1/vehicles/c000gone/renewals`, {
      headers: { "x-test-role": UserRole.ADMIN, "x-test-user": adminId },
    });
    expect(list.status).toBe(404);
  });
});
