import { getQueueToken } from "@nestjs/bullmq";
import { BadRequestException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { GeofencesService } from "../src/modules/geofences/geofences.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { TelematicsController } from "../src/modules/telematics/telematics.controller";
import {
  GeofenceStatusQuerySchema,
  ListPingsQuerySchema,
} from "../src/modules/telematics/telematics.schemas";
import { GPS_INGEST_QUEUE, TelematicsService } from "../src/modules/telematics/telematics.service";

// ───────────────────────────────────────────────────────────────────────────
// Part 1 — schema / pipe layer (no server). Pins the read-query contracts the
// endpoints validate before the handler runs: the raw-list pagination/sort
// bounds and the geofence circle-XOR-polygon rule + polygon parsing.
// ───────────────────────────────────────────────────────────────────────────

describe("ListPingsQuerySchema (raw trace list, pipe layer)", () => {
  const pipe = new ZodValidationPipe(ListPingsQuerySchema);

  test("valid query parses (dates coerced, take bounded)", () => {
    const parsed = pipe.transform({
      from: "2026-02-01",
      to: "2026-02-28",
      sortBy: "timestamp",
      sortDir: "asc",
      skip: "0",
      take: "50",
    });
    expect(parsed.from).toBeInstanceOf(Date);
    expect(parsed.to).toBeInstanceOf(Date);
    expect(parsed.take).toBe(50);
    expect(parsed.sortBy).toBe("timestamp");
  });

  test("an unknown query key → 400 (.strict())", () => {
    expect(() => pipe.transform({ form: "2026-02-01" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → 400 (not silently clamped)", () => {
    expect(() => pipe.transform({ take: "5000" })).toThrow(BadRequestException);
  });

  test("a non-whitelisted sortBy column → 400", () => {
    expect(() => pipe.transform({ sortBy: "latitude" })).toThrow(BadRequestException);
  });
});

describe("GeofenceStatusQuerySchema (geofence check, pipe layer)", () => {
  const pipe = new ZodValidationPipe(GeofenceStatusQuerySchema);

  test("a complete circle parses", () => {
    const parsed = pipe.transform({
      centerLatitude: "27.7172",
      centerLongitude: "85.324",
      radiusMeters: "100",
    });
    expect(parsed.centerLatitude).toBeCloseTo(27.7172, 6);
    expect(parsed.radiusMeters).toBe(100);
    expect(parsed.polygon).toBeUndefined();
  });

  test("a polygon parses to a closed WKT ring (lon lat order)", () => {
    const parsed = pipe.transform({ polygon: "85.30,27.70;85.35,27.70;85.35,27.74" });
    expect(parsed.polygon).toBeDefined();
    // 3 supplied vertices auto-close to 4 (first repeated last); WKT is lon lat.
    expect(parsed.polygon?.vertexCount).toBe(4);
    expect(parsed.polygon?.wkt).toBe("POLYGON((85.3 27.7, 85.35 27.7, 85.35 27.74, 85.3 27.7))");
  });

  test("both a circle and a polygon → 400 (exactly one)", () => {
    expect(() =>
      pipe.transform({
        centerLatitude: "27.7172",
        centerLongitude: "85.324",
        radiusMeters: "100",
        polygon: "85.30,27.70;85.35,27.70;85.35,27.74",
      }),
    ).toThrow(BadRequestException);
  });

  test("neither a circle nor a polygon → 400", () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });

  test("a partial circle (missing radius) → 400", () => {
    expect(() => pipe.transform({ centerLatitude: "27.7172", centerLongitude: "85.324" })).toThrow(
      BadRequestException,
    );
  });

  test("a polygon with fewer than 3 vertices → 400", () => {
    expect(() => pipe.transform({ polygon: "85.30,27.70;85.35,27.70" })).toThrow(
      BadRequestException,
    );
  });

  test("an out-of-range coordinate → 400", () => {
    expect(() =>
      pipe.transform({ centerLatitude: "120", centerLongitude: "85.324", radiusMeters: "100" }),
    ).toThrow(BadRequestException);
  });

  test("an unknown query key → 400 (.strict())", () => {
    expect(() =>
      pipe.transform({
        centerLatitude: "27.7172",
        centerLongitude: "85.324",
        radiusMeters: "100",
        extra: "1",
      }),
    ).toThrow(BadRequestException);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Part 2 — HTTP boundary (real AuthGuard + RolesGuard chain). The RBAC gate.
// ───────────────────────────────────────────────────────────────────────────

// RBAC-gate tests for the T5 read split (ADR-0029 T5, ADR-0028 c6 / ADR-0027
// c7), mirroring roles.guard.test.ts / telematics.controller.test.ts Part 2:
// the REAL @UseGuards(AuthGuard, RolesGuard) chain (AUTH session source stubbed
// and driven by an `x-test-role` header) hit over real HTTP, proving the
// per-route @RequirePermission decorations enforce the split end-to-end:
//
//   • gps:read-raw   (…/pings)           → ADMIN only      (403 for OFFICE_STAFF)
//   • gps:read-derived (…/location,       → ADMIN + OFFICE_STAFF
//                       …/geofence-status)
//   • anonymous → 401 from AuthGuard on every route (the 401 ≠ 403 contract)
//
// A REAL PrismaService serves the read handlers; the 200 cases use a
// cuid-shaped vehicleId with no pings, so they return empty / null — all the
// RBAC gate needs (spatial correctness is telematics.read.service.test.ts's
// job). The gps-ingest queue is faked (reads never touch it; no live Redis).

const fakeQueue = { add: async () => ({ id: "job_fake" }) };

// AUTH stub identical to telematics.controller.test.ts: AuthGuard calls
// getSession({ headers }); the `x-test-role` header drives the caller's role,
// so one app instance serves every case. No header → null session → 401.
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

// A cuid-shaped vehicle id with no pings seeded — every read returns empty /
// null / inside:null, i.e. HTTP 200, which is all the gate test asserts.
const VEHICLE_ID = "ckreadrbac000000";
const PINGS = `/api/v1/telematics/vehicles/${VEHICLE_ID}/pings`;
const LOCATION = `/api/v1/telematics/vehicles/${VEHICLE_ID}/location`;
const GEOFENCE = `/api/v1/telematics/vehicles/${VEHICLE_ID}/geofence-status?centerLatitude=27.7172&centerLongitude=85.324&radiusMeters=100`;

describe("Telematics read RBAC (gps:read-raw / gps:read-derived, ADR-0029 T5)", () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TelematicsController],
      providers: [
        TelematicsService,
        GeofencesService,
        PrismaService,
        { provide: getQueueToken(GPS_INGEST_QUEUE), useValue: fakeQueue },
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
  });

  afterAll(async () => {
    await app.close();
  });

  // GET `path`; `role` undefined → no header → 401 path.
  async function status(path: string, role?: string): Promise<number> {
    const headers: Record<string, string> = role === undefined ? {} : { "x-test-role": role };
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.status;
  }

  // ── gps:read-raw — the most-privileged data access, ADMIN only ──

  test("raw pings: ADMIN → 200", async () => {
    expect(await status(PINGS, UserRole.ADMIN)).toBe(200);
  });

  test("raw pings: OFFICE_STAFF → 403 (authed but lacks gps:read-raw)", async () => {
    expect(await status(PINGS, UserRole.OFFICE_STAFF)).toBe(403);
  });

  test("raw pings: DRIVER (reserved, inert) → 403", async () => {
    expect(await status(PINGS, UserRole.DRIVER)).toBe(403);
  });

  test("raw pings: anonymous → 401 from AuthGuard, NOT 403", async () => {
    expect(await status(PINGS)).toBe(401);
  });

  // ── gps:read-derived — live location, ADMIN + OFFICE_STAFF ──

  test("derived location: ADMIN → 200", async () => {
    expect(await status(LOCATION, UserRole.ADMIN)).toBe(200);
  });

  test("derived location: OFFICE_STAFF → 200 (the positive half of the split)", async () => {
    expect(await status(LOCATION, UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("derived location: anonymous → 401", async () => {
    expect(await status(LOCATION)).toBe(401);
  });

  // ── gps:read-derived — geofence status, ADMIN + OFFICE_STAFF ──

  test("derived geofence-status: ADMIN → 200", async () => {
    expect(await status(GEOFENCE, UserRole.ADMIN)).toBe(200);
  });

  test("derived geofence-status: OFFICE_STAFF → 200", async () => {
    expect(await status(GEOFENCE, UserRole.OFFICE_STAFF)).toBe(200);
  });

  test("derived geofence-status: DRIVER (reserved, inert) → 403", async () => {
    expect(await status(GEOFENCE, UserRole.DRIVER)).toBe(403);
  });

  test("derived geofence-status: anonymous → 401", async () => {
    expect(await status(GEOFENCE)).toBe(401);
  });
});
