// RBAC capability-matrix tests for the 2026-07-02 hardening.
//
// Context: the whole-project audit found 12 of 16 controllers AuthGuard-only —
// RolesGuard is opt-in (no decorator → any signed-in role), so the live DRIVER
// role's phone bearer credential could CRUD vehicles, drivers (Tier-2 PII),
// customers, jobs, expense-logs, invoices (including the irreversible
// issue/cancel lifecycle), and maintenance, and read reports. The hardening
// wires `@RequirePermission` + RolesGuard onto every domain controller, mints
// the missing `maintenance:*` / `invoices:read` / `invoices:write` tokens, and
// re-targets the `toUserRole` fail-closed coercion at DRIVER (the
// least-privileged LIVE role — the old OFFICE_STAFF target would now be an
// escalation).
//
// Three layers, cheapest-exhaustive first:
//   1. permissions.ts unit — the new tokens sit in exactly the right role sets,
//      and the coercion fails closed to DRIVER.
//   2. Reflection — EVERY gated controller class (and every invoices handler)
//      carries the AuthGuard + RolesGuard pair and the expected token. This is
//      the exhaustive wiring proof: a controller dropped from this table or a
//      typo'd token fails here without booting anything.
//   3. HTTP boundary — one real end-to-end matrix over the composed chain
//      (vehicles for the deny/allow split, trips for DRIVER continuity), since
//      metadata alone doesn't prove the chain executes. The guard MACHINERY
//      itself is pinned by roles.guard.test.ts; the per-module read/write
//      splits for geofences/telematics/notification-logs are pinned by their
//      own controller tests.
import type { AddressInfo } from "node:net";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { Logger } from "nestjs-pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { REQUIRE_PERMISSION_KEY } from "../src/modules/auth/decorators";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { roleHasCapability, toUserRole, type Capability } from "../src/modules/auth/permissions";
import { RolesGuard } from "../src/modules/auth/roles.guard";
import { AgentController } from "../src/modules/agent/agent.controller";
import { AuthController } from "../src/modules/auth/auth.controller";
import { CustomersController } from "../src/modules/customers/customers.controller";
import { DocumentsController } from "../src/modules/documents/documents.controller";
import { DriversController } from "../src/modules/drivers/drivers.controller";
import { DriversService } from "../src/modules/drivers/drivers.service";
import { ExpenseLogsController } from "../src/modules/expense-logs/expense-logs.controller";
import { FuelLogsController } from "../src/modules/fuel-logs/fuel-logs.controller";
import { InvoicesController } from "../src/modules/invoices/invoices.controller";
import { JobsController } from "../src/modules/jobs/jobs.controller";
import { ServiceRecordsController } from "../src/modules/maintenance/service-records.controller";
import { ServiceSchedulesController } from "../src/modules/maintenance/service-schedules.controller";
import { ReportsController } from "../src/modules/reports/reports.controller";
import { RoutingController } from "../src/modules/routing/routing.controller";
import { TrackersController } from "../src/modules/telematics/trackers.controller";
import { TripsController } from "../src/modules/trips/trips.controller";
import { TripsService } from "../src/modules/trips/trips.service";
import { VehiclesController } from "../src/modules/vehicles/vehicles.controller";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";
import { seedDriver, seedUser } from "./fixtures/trip";

// ---------------------------------------------------------------------------
// 1 — permissions.ts: the newly-minted tokens and the re-targeted coercion
// ---------------------------------------------------------------------------

describe("newly-minted capability tokens (2026-07-02 hardening)", () => {
  test("maintenance:* is on the operational floor (ADMIN + OFFICE_STAFF), not DRIVER", () => {
    expect(roleHasCapability(UserRole.ADMIN, "maintenance:*")).toBe(true);
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "maintenance:*")).toBe(true);
    expect(roleHasCapability(UserRole.DRIVER, "maintenance:*")).toBe(false);
  });

  test("invoices:read is on the operational floor; invoices:write is ADMIN-only", () => {
    expect(roleHasCapability(UserRole.ADMIN, "invoices:read")).toBe(true);
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "invoices:read")).toBe(true);
    expect(roleHasCapability(UserRole.DRIVER, "invoices:read")).toBe(false);

    expect(roleHasCapability(UserRole.ADMIN, "invoices:write")).toBe(true);
    // The load-bearing half of the split: an office-staff session reads and
    // downloads invoices but cannot create/issue/cancel/credit one.
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "invoices:write")).toBe(false);
    expect(roleHasCapability(UserRole.DRIVER, "invoices:write")).toBe(false);
  });
});

describe("agent capability token (ADR-0043 c1, ticket A5)", () => {
  test("agent:use is ADMIN-only — not OFFICE_STAFF, not DRIVER", () => {
    expect(roleHasCapability(UserRole.ADMIN, "agent:use")).toBe(true);
    // The load-bearing half (c1): the agent executes autonomous writes with
    // no confirmation gate (from A7), so v1 access stays with the
    // accountable owner. Widening to OFFICE_STAFF is a deliberate later
    // grant (ADR-0043 "Revisit when"), one row in permissions.ts.
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "agent:use")).toBe(false);
    expect(roleHasCapability(UserRole.DRIVER, "agent:use")).toBe(false);
  });
});

describe("driver GPS grants (ADR-0035 D4 ingest + D6 read-derived, each WITH its scope)", () => {
  test("gps:ingest is ADMIN + DRIVER — not OFFICE_STAFF", () => {
    expect(roleHasCapability(UserRole.ADMIN, "gps:ingest")).toBe(true);
    // The D4 grant (ADR-0034 c5's hard rule): DRIVER holds this ONLY because
    // the same change landed TelematicsService.assertDriverCanIngest — the
    // own-IN_PROGRESS-trip batch predicate (telematics.controller.test.ts
    // pins its 202/403 matrix over real rows). Route token = "may ingest";
    // service predicate = "only for your own active trip". Both required.
    expect(roleHasCapability(UserRole.DRIVER, "gps:ingest")).toBe(true);
    // OFFICE_STAFF stays off the ingest path (ADR-0029 c11's posture: office
    // staff read derived positions, they do not produce them).
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "gps:ingest")).toBe(false);
  });

  test("gps:read-derived is granted to DRIVER as of D6 — WITH its own-vehicle scope", () => {
    // The D6 grant (ADR-0034 c5's hard rule, again): DRIVER holds this ONLY
    // because the same change landed TelematicsService.assertDriverCanReadVehicle
    // — the own-IN_PROGRESS-trip vehicle predicate (telematics.read.controller
    // .test.ts pins its 200/403 matrix over real rows) — while the fleet-wide
    // /positions/latest stays 403 for a DRIVER (assertCanReadFleetPositions).
    // Route token = "may read derived status"; service predicate = "only your
    // own vehicle". Both required.
    expect(roleHasCapability(UserRole.DRIVER, "gps:read-derived")).toBe(true);
    // The raw trace stays ADMIN-only — D6 does not widen it (ADR-0027 c7).
    expect(roleHasCapability(UserRole.DRIVER, "gps:read-raw")).toBe(false);
    // ADMIN + OFFICE_STAFF still hold it on the operational floor, unchanged.
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "gps:read-derived")).toBe(true);
    expect(roleHasCapability(UserRole.ADMIN, "gps:read-derived")).toBe(true);
  });
});

describe("tracker-register capability tokens (ADR-0042 M4)", () => {
  test("trackers:read is on the operational floor; trackers:write is ADMIN-only", () => {
    expect(roleHasCapability(UserRole.ADMIN, "trackers:read")).toBe(true);
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "trackers:read")).toBe(true);
    expect(roleHasCapability(UserRole.DRIVER, "trackers:read")).toBe(false);

    expect(roleHasCapability(UserRole.ADMIN, "trackers:write")).toBe(true);
    // The load-bearing half of the split: an office-staff session sees which
    // vehicle carries which unit but cannot re-point the IMEI → vehicle
    // mapping that decides where every hardware ping lands.
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "trackers:write")).toBe(false);
    expect(roleHasCapability(UserRole.DRIVER, "trackers:write")).toBe(false);
  });
});

describe("fleet-document capability tokens (ADR-0049 F2)", () => {
  test("documents:read and documents:write are on the operational floor, not DRIVER", () => {
    for (const token of ["documents:read", "documents:write"] as const) {
      expect(roleHasCapability(UserRole.ADMIN, token)).toBe(true);
      expect(roleHasCapability(UserRole.OFFICE_STAFF, token)).toBe(true);
      expect(roleHasCapability(UserRole.DRIVER, token)).toBe(false);
    }
  });

  test("documents:delete is ADMIN-only — the evidence-destruction verb (c6)", () => {
    expect(roleHasCapability(UserRole.ADMIN, "documents:delete")).toBe(true);
    // The load-bearing half of the three-token design: an office-staff
    // session uploads and edits the papers but cannot destroy the bytes.
    expect(roleHasCapability(UserRole.OFFICE_STAFF, "documents:delete")).toBe(false);
    expect(roleHasCapability(UserRole.DRIVER, "documents:delete")).toBe(false);
  });
});

describe("toUserRole fails closed to DRIVER (the least-privileged live role)", () => {
  test("exact live values pass through", () => {
    expect(toUserRole(UserRole.ADMIN)).toBe(UserRole.ADMIN);
    expect(toUserRole(UserRole.OFFICE_STAFF)).toBe(UserRole.OFFICE_STAFF);
    expect(toUserRole(UserRole.DRIVER)).toBe(UserRole.DRIVER);
  });

  test("null / undefined / unknown coerce to DRIVER, never to an operational role", () => {
    // Coercing to OFFICE_STAFF (the pre-D2 behavior) would ESCALATE now that
    // every operational controller requires a capability OFFICE_STAFF holds.
    expect(toUserRole(null)).toBe(UserRole.DRIVER);
    expect(toUserRole(undefined)).toBe(UserRole.DRIVER);
    expect(toUserRole("")).toBe(UserRole.DRIVER);
    expect(toUserRole("SUPER_USER")).toBe(UserRole.DRIVER);
    expect(toUserRole("admin")).toBe(UserRole.DRIVER); // case-sensitive on purpose
  });
});

// ---------------------------------------------------------------------------
// 2 — Reflection: every domain controller is wired, with the right token
// ---------------------------------------------------------------------------

// NestJS stores @UseGuards metadata under this key (GUARDS_METADATA in
// @nestjs/common/constants — inlined here to avoid the deep package import).
const GUARDS_METADATA = "__guards__";

// The exhaustive class-level wiring table. Adding a domain controller without
// adding it here is deliberate friction: the new controller's PR must state
// its capability.
const CLASS_TOKEN_TABLE: readonly [string, object, Capability][] = [
  // Class-level single token, NOT the invoices/trackers per-route split:
  // every agent route carries the same privilege (talking to the agent); the
  // per-TOOL authorization inside a turn is the registry's job (ADR-0043 c1).
  ["AgentController", AgentController, "agent:use"],
  ["VehiclesController", VehiclesController, "vehicles:*"],
  ["DriversController", DriversController, "drivers:*"],
  ["CustomersController", CustomersController, "customers:*"],
  ["JobsController", JobsController, "jobs:*"],
  ["TripsController", TripsController, "trips:*"],
  // ADR-0047 W6: the route-preview endpoint (the dispatch map's polyline + ETA)
  // rides the dispatch read capability — trips:* — via the composed chain. All
  // three live roles hold trips:* (dispatch continuity), so the gate's live wall
  // is authentication; roles.guard.test.ts pins the capability-absent denial.
  ["RoutingController", RoutingController, "trips:*"],
  ["FuelLogsController", FuelLogsController, "fuel-logs:*"],
  ["ExpenseLogsController", ExpenseLogsController, "expense-logs:*"],
  ["ReportsController", ReportsController, "reports:read"],
  ["ServiceSchedulesController", ServiceSchedulesController, "maintenance:*"],
  ["ServiceRecordsController", ServiceRecordsController, "maintenance:*"],
];

// The invoices per-route split (the geofences read/write pattern applied to
// money): reads for both office roles, writes ADMIN-only.
const INVOICES_HANDLER_TABLE: readonly [string, Capability][] = [
  ["list", "invoices:read"],
  ["getById", "invoices:read"],
  ["getPdf", "invoices:read"],
  ["create", "invoices:write"],
  ["update", "invoices:write"],
  ["cancel", "invoices:write"],
  ["issue", "invoices:write"],
  ["createCreditNote", "invoices:write"],
  ["addLine", "invoices:write"],
  ["buildFromJob", "invoices:write"],
  ["updateLine", "invoices:write"],
  ["removeLine", "invoices:write"],
];

// The trackers per-route split (ADR-0042 M4 — the geofences read/write
// pattern applied to the tracker register). There is deliberately NO delete
// handler: unassign frees the vehicle slot, RETIRED ends the lifecycle.
const TRACKERS_HANDLER_TABLE: readonly [string, Capability][] = [
  ["list", "trackers:read"],
  ["getById", "trackers:read"],
  ["create", "trackers:write"],
  ["update", "trackers:write"],
];

// The documents per-route split (ADR-0049 c6 — the invoices/trackers pattern
// with a THIRD verb): read + write for both office roles, DELETE ADMIN-only
// because deleting the bytes irreversibly destroys compliance evidence.
const DOCUMENTS_HANDLER_TABLE: readonly [string, Capability][] = [
  ["upload", "documents:write"],
  ["list", "documents:read"],
  ["getById", "documents:read"],
  ["getContent", "documents:read"],
  ["update", "documents:write"],
  ["remove", "documents:delete"],
];

// DriversController's two login-link routes (2026-07-05, ADR-0034 c8)
// override the class-level `drivers:*` with `users:manage`: deciding which
// login sees which driver's own-record-scoped data is identity/account
// administration, not ordinary Driver field editing — OFFICE_STAFF holds
// `drivers:*` but not `users:manage`, so these two routes are ADMIN-only
// even though the rest of DriversController is on the shared operational
// floor. Every other DriversController route stays under the class-level
// token (CLASS_TOKEN_TABLE above) — only these two are listed here.
const DRIVERS_LOGIN_LINK_HANDLER_TABLE: readonly [string, Capability][] = [
  ["linkLogin", "users:manage"],
  ["unlinkLogin", "users:manage"],
];

describe("controller wiring (reflection over guard + permission metadata)", () => {
  test.each(CLASS_TOKEN_TABLE)(
    "%s requires its capability at class level",
    (_name, ctor, token) => {
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, ctor)).toBe(token);
    },
  );

  test.each(CLASS_TOKEN_TABLE)("%s runs the AuthGuard + RolesGuard chain", (_name, ctor) => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, ctor) ?? [];
    expect(guards).toContain(AuthGuard);
    expect(guards).toContain(RolesGuard);
  });

  test("InvoicesController runs the chain at class level with the per-route split", () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, InvoicesController) ?? [];
    expect(guards).toContain(AuthGuard);
    expect(guards).toContain(RolesGuard);
    // No class-level token: every route declares its own side of the split.
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, InvoicesController)).toBeUndefined();
  });

  test.each(INVOICES_HANDLER_TABLE)("InvoicesController.%s requires %s", (method, token) => {
    const handler: unknown = InvoicesController.prototype[method as keyof InvoicesController];
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler as object)).toBe(token);
  });

  test("TrackersController runs the chain at class level with the per-route split", () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, TrackersController) ?? [];
    expect(guards).toContain(AuthGuard);
    expect(guards).toContain(RolesGuard);
    // No class-level token: every route declares its own side of the split.
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, TrackersController)).toBeUndefined();
  });

  test.each(TRACKERS_HANDLER_TABLE)("TrackersController.%s requires %s", (method, token) => {
    const handler: unknown = TrackersController.prototype[method as keyof TrackersController];
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler as object)).toBe(token);
  });

  test("DocumentsController runs the chain at class level with the per-route split", () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, DocumentsController) ?? [];
    expect(guards).toContain(AuthGuard);
    expect(guards).toContain(RolesGuard);
    // No class-level token: every route declares its own verb of the split.
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, DocumentsController)).toBeUndefined();
  });

  test.each(DOCUMENTS_HANDLER_TABLE)("DocumentsController.%s requires %s", (method, token) => {
    const handler: unknown = DocumentsController.prototype[method as keyof DocumentsController];
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler as object)).toBe(token);
  });

  test("TrackersController exposes NO delete handler (ADR-0042: RETIRE, never delete)", () => {
    const proto = TrackersController.prototype as unknown as Record<string, unknown>;
    expect(proto.remove).toBeUndefined();
    expect(proto.delete).toBeUndefined();
  });

  test.each(DRIVERS_LOGIN_LINK_HANDLER_TABLE)(
    "DriversController.%s requires %s (method-level override of the class token)",
    (method, token) => {
      const handler: unknown = DriversController.prototype[method as keyof DriversController];
      expect(typeof handler).toBe("function");
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler as object)).toBe(token);
    },
  );

  test("GET /me stays capability-free — any authenticated role reads its own role", () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AuthController)).toBeUndefined();
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AuthController.prototype.me),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3 — HTTP boundary: the composed chain enforces the matrix end-to-end
// ---------------------------------------------------------------------------

// AUTH stub per the geofences/telematics precedent: AuthGuard calls
// getSession({ headers }); `x-test-role` drives the role, `x-test-user` the
// user id (so the DRIVER-continuity case can be a user with a real Driver
// link). No header → null session → 401.
const AUTH_STUB = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) => {
      const role = headers.get("x-test-role");
      if (role === null) return null;
      const userId = headers.get("x-test-user") ?? "user_rbac_admin";
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

describe("RBAC HTTP matrix (real AuthGuard + RolesGuard over gated controllers)", () => {
  let app: INestApplication;
  let baseUrl: string;
  let linkedDriverUserId: string;
  let loginLinkDriverId: string;
  let unlinkedDriverLoginEmail: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VehiclesController, TripsController, DriversController],
      providers: [
        VehiclesService,
        TripsService,
        DriversService,
        DriverScopeService,
        PrismaService,
        AuthGuard,
        RolesGuard,
        { provide: AUTH, useValue: AUTH_STUB },
        // TripsController injects nestjs-pino's Logger (T_SLI2). This module
        // does not import LoggerModule, so bind a no-op fake; this matrix
        // never asserts on SLI logging.
        { provide: Logger, useValue: { log: () => undefined } },
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
    // A DRIVER user WITH a Driver link — the continuity case: the route gate
    // admits trips:* and the row scope then resolves their own records.
    const adminId = await seedUser(prisma);
    linkedDriverUserId = await seedUser(prisma, UserRole.DRIVER);
    await seedDriver(prisma, adminId, { userId: linkedDriverUserId });

    // A second, UNLINKED driver + an unlinked DRIVER-role login, for the
    // login-link route's allow/deny pair below (a real target so the
    // ADMIN-succeeds case actually reaches 201, not a 404 for lack of one).
    const loginLinkDriver = await seedDriver(prisma, adminId, { licenseNumber: "LIC-RBAC-LINK" });
    loginLinkDriverId = loginLinkDriver.id;
    const unlinkedLoginUserId = await seedUser(prisma, UserRole.DRIVER);
    const unlinkedLogin = await prisma.user.findUniqueOrThrow({
      where: { id: unlinkedLoginUserId },
    });
    unlinkedDriverLoginEmail = unlinkedLogin.email;
  });

  afterAll(async () => {
    await app.close();
  });

  async function get(path: string, role?: string, userId?: string): Promise<number> {
    const headers: Record<string, string> = {};
    if (role !== undefined) headers["x-test-role"] = role;
    if (userId !== undefined) headers["x-test-user"] = userId;
    const res = await fetch(`${baseUrl}${path}`, { headers });
    return res.status;
  }

  async function post(
    path: string,
    body: unknown,
    role?: string,
    userId?: string,
  ): Promise<number> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (role !== undefined) headers["x-test-role"] = role;
    if (userId !== undefined) headers["x-test-user"] = userId;
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return res.status;
  }

  test("anonymous on /vehicles → 401 (AuthGuard, unchanged)", async () => {
    expect(await get("/api/v1/vehicles")).toBe(401);
  });

  test("DRIVER on /vehicles → 403 — the audit's headline gap, closed", async () => {
    // Before the hardening this returned 200 with the full fleet register.
    expect(await get("/api/v1/vehicles", UserRole.DRIVER)).toBe(403);
  });

  test("OFFICE_STAFF and ADMIN keep /vehicles (operational floor)", async () => {
    expect(await get("/api/v1/vehicles", UserRole.OFFICE_STAFF)).toBe(200);
    expect(await get("/api/v1/vehicles", UserRole.ADMIN)).toBe(200);
  });

  test("DRIVER continuity: a linked driver still lists their own trips → 200", async () => {
    // The route gate admits DRIVER (trips:* is theirs); DriverScopeService
    // then scopes rows. The phone app's flows survive the hardening.
    expect(await get("/api/v1/trips", UserRole.DRIVER, linkedDriverUserId)).toBe(200);
  });

  test("DRIVER without a Driver link on /trips → 403 (row scope fails closed)", async () => {
    // Passes the route gate (trips:* held) and is then rejected by the
    // service-layer own-record predicate — proving both layers are live and
    // ordered as designed (gate = operation class, scope = records).
    expect(await get("/api/v1/trips", UserRole.DRIVER, "user_rbac_unlinked")).toBe(403);
  });

  test("OFFICE_STAFF on POST /drivers/:id/login-link → 403 — users:manage, not drivers:*, gates this route", async () => {
    // OFFICE_STAFF holds drivers:* (the rest of DriversController) but not
    // users:manage — the route gate must reject before the body/service
    // layer ever runs, which is why an arbitrary body is fine here.
    expect(
      await post(
        `/api/v1/drivers/${loginLinkDriverId}/login-link`,
        { email: unlinkedDriverLoginEmail },
        UserRole.OFFICE_STAFF,
      ),
    ).toBe(403);
  });

  test("ADMIN on POST /drivers/:id/login-link → 201 — the users:manage grant holds", async () => {
    expect(
      await post(
        `/api/v1/drivers/${loginLinkDriverId}/login-link`,
        { email: unlinkedDriverLoginEmail },
        UserRole.ADMIN,
      ),
    ).toBe(201);
  });
});
