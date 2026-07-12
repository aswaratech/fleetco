import type { AddressInfo } from "node:net";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { MockRoutingProvider } from "../src/modules/routing/mock.routing-provider";
import { RoutingController } from "../src/modules/routing/routing.controller";
import { RoutePreviewSchema } from "../src/modules/routing/routing.schemas";
import { RoutingProvider } from "../src/modules/routing/routing-provider";

// Two layers, mirroring the trips/rbac controller tests:
//   1. Pipe layer — the RoutePreviewSchema `.strict()` bounds, tested directly.
//   2. HTTP boundary — the REAL AuthGuard + RolesGuard chain over the endpoint,
//      so the trips:* gate (401 unauthenticated; 200 for every live role that
//      holds trips:*) and the { geometryLatLng, distanceMeters, durationSeconds }
//      shape are proven end-to-end. The exhaustive class-level wiring proof lives
//      in rbac.matrix.test.ts (CLASS_TOKEN_TABLE); this file proves the chain runs.

const KATHMANDU = { lat: 27.7172, lng: 85.324 };
const POKHARA = { lat: 28.2096, lng: 83.9856 };

describe("RoutePreviewSchema (pipe layer)", () => {
  const pipe = new ZodValidationPipe(RoutePreviewSchema);

  test("accepts two in-range points", () => {
    expect(pipe.transform({ origin: KATHMANDU, destination: POKHARA })).toEqual({
      origin: KATHMANDU,
      destination: POKHARA,
    });
  });

  test("rejects an unknown key (.strict())", () => {
    expect(() =>
      pipe.transform({ origin: KATHMANDU, destination: POKHARA, waypoints: [] }),
    ).toThrow();
  });

  test("rejects an out-of-range latitude", () => {
    expect(() => pipe.transform({ origin: { lat: 91, lng: 0 }, destination: POKHARA })).toThrow();
  });

  test("rejects an out-of-range longitude", () => {
    expect(() =>
      pipe.transform({ origin: KATHMANDU, destination: { lat: 0, lng: 181 } }),
    ).toThrow();
  });

  test("rejects a missing destination", () => {
    expect(() => pipe.transform({ origin: KATHMANDU })).toThrow();
  });
});

// AUTH stub per the rbac.matrix precedent: `x-test-role` drives the role; an
// absent header → null session → 401.
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

describe("RoutingController route-preview (auth gate + shape)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RoutingController],
      providers: [
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        { provide: RoutingProvider, useValue: new MockRoutingProvider() },
      ],
    }).compile();

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

  async function preview(role: string | undefined, body: unknown): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (role !== undefined) headers["x-test-role"] = role;
    return fetch(`${baseUrl}/api/v1/routing/route-preview`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  const validBody = { origin: KATHMANDU, destination: POKHARA };

  test("401 when unauthenticated (no session) — the real wall", async () => {
    expect((await preview(undefined, validBody)).status).toBe(401);
  });

  test("200 + { geometryLatLng, distanceMeters, durationSeconds } for ADMIN", async () => {
    const res = await preview(UserRole.ADMIN, validBody);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      geometryLatLng: [number, number][];
      distanceMeters: number;
      durationSeconds: number;
    };
    expect(Array.isArray(json.geometryLatLng)).toBe(true);
    expect(json.geometryLatLng[0]).toEqual([KATHMANDU.lat, KATHMANDU.lng]);
    expect(json.geometryLatLng[json.geometryLatLng.length - 1]).toEqual([POKHARA.lat, POKHARA.lng]);
    expect(typeof json.distanceMeters).toBe("number");
    expect(typeof json.durationSeconds).toBe("number");
    expect(json.distanceMeters).toBeGreaterThan(0);
  });

  test("200 for OFFICE_STAFF (holds trips:*)", async () => {
    expect((await preview(UserRole.OFFICE_STAFF, validBody)).status).toBe(200);
  });

  test("200 for DRIVER — trips:* continuity (a driver previews their own haul route)", async () => {
    expect((await preview(UserRole.DRIVER, validBody)).status).toBe(200);
  });

  test("400 for an invalid body (out-of-range coordinate)", async () => {
    expect(
      (await preview(UserRole.ADMIN, { origin: { lat: 999, lng: 0 }, destination: POKHARA }))
        .status,
    ).toBe(400);
  });
});
