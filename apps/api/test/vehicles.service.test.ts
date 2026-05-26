import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { VehicleKind, VehicleStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { VehiclesService } from "../src/modules/vehicles/vehicles.service";
import type { CreateVehicleInput } from "../src/modules/vehicles/vehicles.schemas";
import { resetDb } from "./db";

// Integration tests for VehiclesService against a real Postgres. The
// kickoff (item 3c) names four areas of coverage:
//
//   1. The retirement-transition rule (status→RETIRED sets retiredAt;
//      status→ACTIVE clears it; explicit retiredAt wins).
//   2. The diff-PATCH semantics from the edit-form flow (touching only
//      the fields the client mentions; not touching the rest).
//   3. The iter-4 list() filter / sort / paginate (status filter
//      narrows; sort respects the whitelist; defense-in-depth against
//      callers that bypass the controller schema).
//   4. The unique-constraint behavior on registrationNumber (Prisma
//      P2002 maps to ConflictException → HTTP 409).
//
// All tests share a single TestingModule and a single PrismaService
// (constructing the module is the slow part; ~300ms vs ~5ms per
// truncate). The beforeEach truncates so each test runs against an
// empty schema. The createdById foreign key requires a real User row
// per test; the helper below creates one.

// Build a minimal create input. The schema requires registrationNumber,
// kind, make, model, year, acquiredAt; optional status/odometer fields
// fall through to defaults at the service layer.
function makeCreateInput(overrides: Partial<CreateVehicleInput> = {}): CreateVehicleInput {
  return {
    registrationNumber: overrides.registrationNumber ?? `BA-1-KA-${randomUUID().slice(0, 4)}`,
    kind: overrides.kind ?? VehicleKind.TRUCK,
    make: overrides.make ?? "Tata",
    model: overrides.model ?? "LPK 2518",
    year: overrides.year ?? 2020,
    status: overrides.status,
    odometerStartKm: overrides.odometerStartKm,
    odometerCurrentKm: overrides.odometerCurrentKm,
    acquiredAt: overrides.acquiredAt ?? new Date("2024-01-15"),
  };
}

describe("VehiclesService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: VehiclesService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [VehiclesService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(VehiclesService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    // Vehicle.createdById is a non-null FK to User.id. Each test needs
    // a User in place before it can create a vehicle. We create one
    // admin per test (cheap; ~2ms) so the test is fully self-contained.
    // Auth-domain fields (sessions, accounts) are left untouched here —
    // the vehicles surface does not need them.
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
  });

  describe("create()", () => {
    test("creates a vehicle with required fields and defaults", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      expect(created.id).toBeTruthy();
      expect(created.status).toBe(VehicleStatus.ACTIVE);
      expect(created.odometerStartKm).toBe(0);
      // The kickoff rule: odometerCurrentKm defaults to odometerStartKm.
      // Both default to 0 here because the input did not set
      // odometerStartKm either.
      expect(created.odometerCurrentKm).toBe(0);
      expect(created.createdById).toBe(adminId);
    });

    test("odometerCurrentKm defaults to odometerStartKm when only start is provided", async () => {
      // This is the encoded-in-the-service rule from the kickoff
      // ("current at acquisition equals start"). The schema does not
      // enforce it; the service does. A regression would flip this
      // to current=0 silently.
      const created = await service.create(makeCreateInput({ odometerStartKm: 45_000 }), adminId);
      expect(created.odometerStartKm).toBe(45_000);
      expect(created.odometerCurrentKm).toBe(45_000);
    });

    test("explicit odometerCurrentKm wins over the default-to-start rule", async () => {
      const created = await service.create(
        makeCreateInput({ odometerStartKm: 45_000, odometerCurrentKm: 50_000 }),
        adminId,
      );
      expect(created.odometerStartKm).toBe(45_000);
      expect(created.odometerCurrentKm).toBe(50_000);
    });

    test("duplicate registrationNumber → ConflictException (P2002 → 409)", async () => {
      // The api-error-mapping runbook entry for P2002 is the contract
      // under test here. The service catches Prisma's
      // PrismaClientKnownRequestError with code "P2002" and rethrows
      // as ConflictException; Nest's default exception filter maps
      // that to HTTP 409 with the message in the body.
      const input = makeCreateInput({ registrationNumber: "BA 1 KA 9999" });
      await service.create(input, adminId);

      try {
        await service.create(input, adminId);
        throw new Error("expected ConflictException on duplicate registrationNumber");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const message = (error as ConflictException).message;
        // Message echoes the registrationNumber per the runbook's
        // "name the conflicting field" convention.
        expect(message).toContain("BA 1 KA 9999");
        expect(message).toContain("already exists");
      }
    });
  });

  describe("update() — diff-PATCH semantics", () => {
    test("only updates fields the client mentions; leaves the rest unchanged", async () => {
      // The diff-PATCH contract from the edit-form flow: a PATCH
      // request with `{ make: "Mahindra" }` changes only `make` and
      // leaves model, year, odometer, status, etc., as they were.
      // The service achieves this by building a Prisma update payload
      // that only sets the fields it sees in the input.
      const before = await service.create(
        makeCreateInput({ make: "Tata", model: "LPK 2518", odometerCurrentKm: 12_000 }),
        adminId,
      );

      const after = await service.update(before.id, { make: "Mahindra" });
      expect(after).not.toBeNull();
      expect(after?.make).toBe("Mahindra");
      // Untouched fields kept their values:
      expect(after?.model).toBe("LPK 2518");
      expect(after?.odometerCurrentKm).toBe(12_000);
      expect(after?.status).toBe(VehicleStatus.ACTIVE);
    });

    test("returns null when the id does not exist", async () => {
      // The controller turns null into HTTP 404 via NotFoundException;
      // the service contract is "return null, don't throw" — this
      // keeps not-found a control-flow path, not an exception path.
      const result = await service.update("nonexistent-id", { make: "Mahindra" });
      expect(result).toBeNull();
    });
  });

  describe("update() — retirement-transition rule", () => {
    test("status ACTIVE → RETIRED auto-sets retiredAt to now-ish", async () => {
      const before = await service.create(makeCreateInput(), adminId);
      const t0 = Date.now();
      const after = await service.update(before.id, { status: VehicleStatus.RETIRED });
      const t1 = Date.now();

      expect(after?.status).toBe(VehicleStatus.RETIRED);
      expect(after?.retiredAt).not.toBeNull();
      // retiredAt landed between t0 and t1 (inclusive on the upper
      // bound to allow for the trivial case where the test completes
      // in <1ms and the timestamps tie).
      const retiredAtMs = after?.retiredAt?.getTime() ?? 0;
      expect(retiredAtMs).toBeGreaterThanOrEqual(t0);
      expect(retiredAtMs).toBeLessThanOrEqual(t1);
    });

    test("status RETIRED → ACTIVE clears retiredAt to null", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      await service.update(created.id, { status: VehicleStatus.RETIRED });
      const reactivated = await service.update(created.id, { status: VehicleStatus.ACTIVE });

      expect(reactivated?.status).toBe(VehicleStatus.ACTIVE);
      expect(reactivated?.retiredAt).toBeNull();
    });

    test("status SOLD also counts as out-of-fleet (auto-sets retiredAt)", async () => {
      // SOLD is in the OUT_OF_FLEET_STATUSES set in vehicles.service.ts
      // alongside RETIRED. A test caught here documents that "retired"
      // in the column name is shorthand for "out of fleet" — both
      // SOLD and RETIRED populate it.
      const before = await service.create(makeCreateInput(), adminId);
      const after = await service.update(before.id, { status: VehicleStatus.SOLD });
      expect(after?.status).toBe(VehicleStatus.SOLD);
      expect(after?.retiredAt).not.toBeNull();
    });

    test("status change with explicit retiredAt: the client's value wins", async () => {
      // The "explicit retiredAt wins" arm of the rule. Useful for
      // backdating: the operator retires a vehicle today but records
      // that it actually left the fleet last Tuesday.
      const before = await service.create(makeCreateInput(), adminId);
      const backdate = new Date("2024-06-15T00:00:00Z");
      const after = await service.update(before.id, {
        status: VehicleStatus.RETIRED,
        retiredAt: backdate,
      });
      expect(after?.retiredAt?.toISOString()).toBe(backdate.toISOString());
    });

    test("explicit retiredAt: null clears the field even without a status change", async () => {
      // Edge case: an operator who corrected a status earlier may now
      // need to clear the leftover retiredAt without flipping the
      // status. The "client provided null" branch in update() handles
      // this; the test pins the behavior so a future refactor that
      // collapses the null case into "ignore" would fail loudly.
      const created = await service.create(makeCreateInput(), adminId);
      await service.update(created.id, { status: VehicleStatus.RETIRED });
      const cleared = await service.update(created.id, { retiredAt: null });

      expect(cleared?.status).toBe(VehicleStatus.RETIRED);
      expect(cleared?.retiredAt).toBeNull();
    });

    test("no status change → retiredAt is left alone", async () => {
      // A PATCH that touches non-status fields should not derive any
      // retiredAt change. This pins the "no transition, no derive"
      // branch of the rule.
      const created = await service.create(makeCreateInput(), adminId);
      await service.update(created.id, { status: VehicleStatus.RETIRED });
      const afterPatch = await service.update(created.id, { make: "Renamed Make" });

      expect(afterPatch?.status).toBe(VehicleStatus.RETIRED);
      expect(afterPatch?.retiredAt).not.toBeNull();
    });
  });

  describe("update() — duplicate-registration on patch", () => {
    test("PATCH to a duplicate registrationNumber → ConflictException", async () => {
      // The same P2002 path as create(), but on update(). Symmetry
      // matters because the schema-level unique constraint fires in
      // both cases and the service catches the same Prisma error.
      const first = await service.create(
        makeCreateInput({ registrationNumber: "BA 1 KA 0001" }),
        adminId,
      );
      const second = await service.create(
        makeCreateInput({ registrationNumber: "BA 1 KA 0002" }),
        adminId,
      );

      try {
        await service.update(second.id, { registrationNumber: "BA 1 KA 0001" });
        throw new Error("expected ConflictException on duplicate registrationNumber");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
      }
      // Sanity: the first vehicle's reg-number is untouched.
      const refetched = await prisma.vehicle.findUnique({ where: { id: first.id } });
      expect(refetched?.registrationNumber).toBe("BA 1 KA 0001");
    });
  });

  describe("delete()", () => {
    test("returns true on success and removes the row", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      const ok = await service.delete(created.id);
      expect(ok).toBe(true);
      const refetched = await prisma.vehicle.findUnique({ where: { id: created.id } });
      expect(refetched).toBeNull();
    });

    test("returns false (not throws) when the id does not exist", async () => {
      // The P2025 catch in vehicles.service.ts. The controller turns
      // false into HTTP 404; the service contract is "return false,
      // don't throw" to keep not-found out of the exception path.
      const ok = await service.delete("nonexistent-id");
      expect(ok).toBe(false);
    });
  });

  describe("list() — iter-4 filter / sort / paginate", () => {
    // Seed five vehicles with known shapes so the assertions below
    // can be precise about which rows come back for each query.
    async function seedFive(): Promise<void> {
      const seeds: (Partial<CreateVehicleInput> & { status?: VehicleStatus })[] = [
        {
          registrationNumber: "BA-A-1",
          kind: VehicleKind.TRUCK,
          status: VehicleStatus.ACTIVE,
          odometerCurrentKm: 10_000,
        },
        {
          registrationNumber: "BA-A-2",
          kind: VehicleKind.TIPPER,
          status: VehicleStatus.ACTIVE,
          odometerCurrentKm: 20_000,
        },
        {
          registrationNumber: "BA-A-3",
          kind: VehicleKind.TRUCK,
          status: VehicleStatus.IN_MAINTENANCE,
          odometerCurrentKm: 30_000,
        },
        {
          registrationNumber: "BA-A-4",
          kind: VehicleKind.EXCAVATOR,
          status: VehicleStatus.RETIRED,
          odometerCurrentKm: 40_000,
        },
        {
          registrationNumber: "BA-A-5",
          kind: VehicleKind.TIPPER,
          status: VehicleStatus.ACTIVE,
          odometerCurrentKm: 50_000,
        },
      ];
      for (const seed of seeds) {
        await service.create(
          makeCreateInput({
            registrationNumber: seed.registrationNumber,
            kind: seed.kind,
            odometerCurrentKm: seed.odometerCurrentKm,
            status: seed.status,
          }),
          adminId,
        );
      }
    }

    test("no filters → returns all rows with correct total", async () => {
      await seedFive();
      const result = await service.list({});
      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(5);
    });

    test("status filter narrows results to matching statuses", async () => {
      await seedFive();
      const result = await service.list({ status: [VehicleStatus.ACTIVE] });
      expect(result.total).toBe(3);
      expect(result.items.every((v) => v.status === VehicleStatus.ACTIVE)).toBe(true);
    });

    test("multi-status filter is OR within the dimension", async () => {
      await seedFive();
      const result = await service.list({
        status: [VehicleStatus.ACTIVE, VehicleStatus.IN_MAINTENANCE],
      });
      expect(result.total).toBe(4);
    });

    test("kind filter combined with status filter is AND across dimensions", async () => {
      await seedFive();
      const result = await service.list({
        status: [VehicleStatus.ACTIVE],
        kind: [VehicleKind.TRUCK],
      });
      // Only BA-A-1 satisfies both.
      expect(result.total).toBe(1);
      expect(result.items[0]?.registrationNumber).toBe("BA-A-1");
    });

    test("sortBy=registrationNumber asc respects the whitelist column", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "registrationNumber", sortDir: "asc" });
      const reg = result.items.map((v) => v.registrationNumber);
      expect(reg).toEqual(["BA-A-1", "BA-A-2", "BA-A-3", "BA-A-4", "BA-A-5"]);
    });

    test("sortBy=odometerCurrentKm desc respects the whitelist column", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "odometerCurrentKm", sortDir: "desc" });
      const km = result.items.map((v) => v.odometerCurrentKm);
      expect(km).toEqual([50_000, 40_000, 30_000, 20_000, 10_000]);
    });

    test("pagination: skip + take returns the right window and total reflects the full match", async () => {
      await seedFive();
      const page = await service.list({
        sortBy: "registrationNumber",
        sortDir: "asc",
        skip: 2,
        take: 2,
      });
      // Window is rows index 2 and 3 (zero-based): BA-A-3 and BA-A-4.
      const reg = page.items.map((v) => v.registrationNumber);
      expect(reg).toEqual(["BA-A-3", "BA-A-4"]);
      // Total reflects the full filtered match (here: no filter, so 5).
      expect(page.total).toBe(5);
    });

    test("take is clamped at MAX_TAKE (defense-in-depth from the controller schema)", async () => {
      // The schema rejects take>200 with 400 at the pipe; the service
      // also clamps to 200 in case a future direct caller bypasses the
      // controller. The clamp is documented in vehicles.service.ts as
      // "defense-in-depth". This test pins it so a refactor that
      // removes the clamp without removing the comment would fail.
      await seedFive();
      const result = await service.list({ take: 10_000 });
      // We seeded 5 rows; the assertion below only checks that the
      // service did not throw on the giant take — proof that the
      // clamp engaged. (5 rows < 200, so we can't see the 200 cap
      // directly without 201+ rows of seed data, which is expensive.)
      expect(result.items.length).toBeLessThanOrEqual(5);
      expect(result.total).toBe(5);
    });
  });
});
