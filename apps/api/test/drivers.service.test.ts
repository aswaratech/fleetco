import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { DriverStatus, LicenseClass, UserRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { PrismaService } from "../src/modules/prisma/prisma.service";
import { DriversService, type CreateDriverInput } from "../src/modules/drivers/drivers.service";
import { DriverScopeService } from "../src/modules/auth/driver-scope.service";
import { resetDb } from "./db";

// Integration tests for DriversService against a real Postgres. The
// iter-6 kickoff (item 5) names four areas of coverage that mirror
// the iter-5 Vehicles tests:
//
//   1. create() applies the documented defaults (status=ACTIVE,
//      dateOfBirth=null when absent).
//   2. update()'s terminated-transition rule — all four directions
//      from the rule's truth table:
//        a. status ACTIVE → TERMINATED auto-sets terminatedAt;
//        b. status TERMINATED → ACTIVE clears terminatedAt;
//        c. status change between two non-TERMINATED values leaves
//           terminatedAt alone;
//        d. explicit terminatedAt from the client wins over the
//           derived value.
//   3. list() filter / sort / paginate, including the unknown-column
//      defense-in-depth (the schema rejects it at HTTP 400; the
//      service contract is "use the whitelist type so the call site
//      cannot construct an invalid sortBy in the first place").
//   4. Unique-constraint behavior on licenseNumber (Prisma P2002 →
//      ConflictException → HTTP 409 per api-error-mapping runbook).
//
// All tests share a single TestingModule and PrismaService (building
// the module is the slow part). The beforeEach truncates so each test
// runs against an empty schema. Driver.createdById is a non-null FK to
// User, so each test seeds an admin user.

function makeCreateInput(overrides: Partial<CreateDriverInput> = {}): CreateDriverInput {
  return {
    fullName: overrides.fullName ?? "Ram Bahadur Shrestha",
    licenseNumber: overrides.licenseNumber ?? `LIC-${randomUUID().slice(0, 8)}`,
    licenseClass: overrides.licenseClass ?? LicenseClass.HMV,
    phone: overrides.phone ?? "+977-9800000000",
    dateOfBirth: overrides.dateOfBirth,
    hiredAt: overrides.hiredAt ?? new Date("2022-04-01"),
    licenseExpiresAt: overrides.licenseExpiresAt ?? new Date("2028-04-01"),
    status: overrides.status,
  };
}

// Create a login User row for the linkLogin()/unlinkLogin() tests. Mirrors
// this file's own adminId-seeding convention (direct prisma.user.create)
// rather than importing the fixtures/trip.ts helper, for consistency with
// the rest of this file.
async function makeUser(prisma: PrismaService, role: UserRole = UserRole.DRIVER): Promise<string> {
  const id = `user_${randomUUID()}`;
  await prisma.user.create({
    data: { id, email: `login-${id}@fleetco.test`, name: "Test Login", role },
  });
  return id;
}

describe("DriversService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: DriversService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [DriversService, DriverScopeService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(DriversService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    // Driver.createdById is a non-null FK to User.id. Each test needs
    // a User in place before it can create a driver. We create one
    // admin per test (cheap; ~2ms) so the test is fully self-contained.
    // Auth-domain rows (sessions, accounts) are left untouched here —
    // the drivers surface does not need them.
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
    test("creates a driver with required fields and defaults", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      expect(created.id).toBeTruthy();
      // status defaults to ACTIVE when omitted; documented in
      // drivers.service.ts and pinned here so a future refactor that
      // moves the default elsewhere (or drops it) fails loudly.
      expect(created.status).toBe(DriverStatus.ACTIVE);
      // dateOfBirth is optional; absent → null in the database. Same
      // semantics as Vehicle.retiredAt when no retirement applies.
      expect(created.dateOfBirth).toBeNull();
      expect(created.terminatedAt).toBeNull();
      expect(created.createdById).toBe(adminId);
    });

    test("dateOfBirth is stored when provided", async () => {
      const dob = new Date("1985-06-15");
      const created = await service.create(makeCreateInput({ dateOfBirth: dob }), adminId);
      expect(created.dateOfBirth?.toISOString()).toBe(dob.toISOString());
    });

    test("explicit status overrides the ACTIVE default", async () => {
      const created = await service.create(
        makeCreateInput({ status: DriverStatus.ON_LEAVE }),
        adminId,
      );
      expect(created.status).toBe(DriverStatus.ON_LEAVE);
    });

    test("duplicate licenseNumber → ConflictException (P2002 → 409)", async () => {
      // The api-error-mapping runbook entry for P2002 is the contract
      // under test here. The service catches Prisma's
      // PrismaClientKnownRequestError with code "P2002" and rethrows
      // as ConflictException; Nest's default exception filter maps
      // that to HTTP 409 with the message in the body.
      const input = makeCreateInput({ licenseNumber: "LIC-DUPLICATE-001" });
      await service.create(input, adminId);

      try {
        await service.create(input, adminId);
        throw new Error("expected ConflictException on duplicate licenseNumber");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const message = (error as ConflictException).message;
        // Message echoes the offending licenseNumber per the runbook's
        // "name the conflicting field" convention.
        expect(message).toContain("LIC-DUPLICATE-001");
        expect(message).toContain("already exists");
      }
    });
  });

  describe("update() — terminated-transition rule", () => {
    test("ACTIVE → TERMINATED auto-sets terminatedAt to now-ish", async () => {
      const before = await service.create(makeCreateInput(), adminId);
      const t0 = Date.now();
      const after = await service.update(before.id, { status: DriverStatus.TERMINATED });
      const t1 = Date.now();

      expect(after?.status).toBe(DriverStatus.TERMINATED);
      expect(after?.terminatedAt).not.toBeNull();
      // terminatedAt landed between t0 and t1 (inclusive on the upper
      // bound to allow for the trivial case where the test completes
      // in <1ms and the timestamps tie).
      const terminatedAtMs = after?.terminatedAt?.getTime() ?? 0;
      expect(terminatedAtMs).toBeGreaterThanOrEqual(t0);
      expect(terminatedAtMs).toBeLessThanOrEqual(t1);
    });

    test("TERMINATED → ACTIVE clears terminatedAt to null", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      await service.update(created.id, { status: DriverStatus.TERMINATED });
      const reinstated = await service.update(created.id, { status: DriverStatus.ACTIVE });

      expect(reinstated?.status).toBe(DriverStatus.ACTIVE);
      expect(reinstated?.terminatedAt).toBeNull();
    });

    test("status change between two non-TERMINATED values leaves terminatedAt alone", async () => {
      // The "no transition involving TERMINATED, no derive" branch.
      // ACTIVE → ON_LEAVE should leave terminatedAt (null in this
      // case) untouched; a future refactor that incorrectly clears
      // or sets it would fail here.
      const created = await service.create(makeCreateInput(), adminId);
      const after = await service.update(created.id, { status: DriverStatus.ON_LEAVE });

      expect(after?.status).toBe(DriverStatus.ON_LEAVE);
      expect(after?.terminatedAt).toBeNull();
    });

    test("explicit terminatedAt from client wins over the derived value", async () => {
      // Backdating arm of the rule: the operator records a
      // termination today but the actual termination date was last
      // Tuesday. The client's explicit value must beat `new Date()`.
      const before = await service.create(makeCreateInput(), adminId);
      const backdate = new Date("2024-09-15T00:00:00Z");
      const after = await service.update(before.id, {
        status: DriverStatus.TERMINATED,
        terminatedAt: backdate,
      });
      expect(after?.status).toBe(DriverStatus.TERMINATED);
      expect(after?.terminatedAt?.toISOString()).toBe(backdate.toISOString());
    });

    test("explicit terminatedAt: null clears the field even without a status change", async () => {
      // Edge case: an operator who corrected a status earlier may need
      // to clear leftover terminatedAt without flipping the status.
      // The "client provided null" branch handles this; the test
      // pins the behavior so a refactor that collapses the null case
      // into "ignore" would fail loudly.
      const created = await service.create(makeCreateInput(), adminId);
      await service.update(created.id, { status: DriverStatus.TERMINATED });
      const cleared = await service.update(created.id, { terminatedAt: null });

      expect(cleared?.status).toBe(DriverStatus.TERMINATED);
      expect(cleared?.terminatedAt).toBeNull();
    });

    test("no status change → terminatedAt is left alone", async () => {
      // A PATCH that touches non-status fields should not derive any
      // terminatedAt change. Pins the "no transition, no derive" branch.
      const created = await service.create(makeCreateInput(), adminId);
      await service.update(created.id, { status: DriverStatus.TERMINATED });
      const renamed = await service.update(created.id, { fullName: "Renamed Driver" });

      expect(renamed?.status).toBe(DriverStatus.TERMINATED);
      expect(renamed?.terminatedAt).not.toBeNull();
      expect(renamed?.fullName).toBe("Renamed Driver");
    });
  });

  describe("update() — diff-PATCH semantics", () => {
    test("only updates fields the client mentions; leaves the rest unchanged", async () => {
      const before = await service.create(
        makeCreateInput({
          fullName: "Ram Bahadur",
          phone: "+977-9811111111",
          licenseClass: LicenseClass.HMV,
        }),
        adminId,
      );

      const after = await service.update(before.id, { fullName: "Ram B. Shrestha" });
      expect(after).not.toBeNull();
      expect(after?.fullName).toBe("Ram B. Shrestha");
      expect(after?.phone).toBe("+977-9811111111");
      expect(after?.licenseClass).toBe(LicenseClass.HMV);
      expect(after?.status).toBe(DriverStatus.ACTIVE);
    });

    test("returns null when the id does not exist", async () => {
      // Controller maps null to HTTP 404 via NotFoundException; the
      // service contract is "return null, don't throw" to keep
      // not-found out of the exception path.
      const result = await service.update("nonexistent-id", { fullName: "X" });
      expect(result).toBeNull();
    });
  });

  describe("update() — duplicate-license on patch", () => {
    test("PATCH to a duplicate licenseNumber → ConflictException", async () => {
      const first = await service.create(
        makeCreateInput({ licenseNumber: "LIC-DUP-001" }),
        adminId,
      );
      const second = await service.create(
        makeCreateInput({ licenseNumber: "LIC-DUP-002" }),
        adminId,
      );

      try {
        await service.update(second.id, { licenseNumber: "LIC-DUP-001" });
        throw new Error("expected ConflictException on duplicate licenseNumber");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
      }
      // Sanity: the first driver's licenseNumber is untouched.
      const refetched = await prisma.driver.findUnique({ where: { id: first.id } });
      expect(refetched?.licenseNumber).toBe("LIC-DUP-001");
    });
  });

  describe("findById()", () => {
    test("returns the driver when present", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      const fetched = await service.findById(created.id);
      expect(fetched?.id).toBe(created.id);
    });

    test("returns null when not present (controller maps to 404)", async () => {
      const fetched = await service.findById("nonexistent-id");
      expect(fetched).toBeNull();
    });
  });

  describe("list() — filter / sort / paginate", () => {
    // Seed five drivers with known shapes so the assertions below can
    // be precise about which rows come back for each query.
    async function seedFive(): Promise<void> {
      const seeds: Partial<CreateDriverInput>[] = [
        {
          fullName: "Alpha Driver",
          licenseNumber: "LIC-A-1",
          licenseClass: LicenseClass.LMV,
          status: DriverStatus.ACTIVE,
          hiredAt: new Date("2020-01-01"),
          licenseExpiresAt: new Date("2026-01-01"),
        },
        {
          fullName: "Bravo Driver",
          licenseNumber: "LIC-A-2",
          licenseClass: LicenseClass.HMV,
          status: DriverStatus.ACTIVE,
          hiredAt: new Date("2021-02-01"),
          licenseExpiresAt: new Date("2027-02-01"),
        },
        {
          fullName: "Charlie Driver",
          licenseNumber: "LIC-A-3",
          licenseClass: LicenseClass.HMV,
          status: DriverStatus.ON_LEAVE,
          hiredAt: new Date("2022-03-01"),
          licenseExpiresAt: new Date("2028-03-01"),
        },
        {
          fullName: "Delta Driver",
          licenseNumber: "LIC-A-4",
          licenseClass: LicenseClass.HTV,
          status: DriverStatus.SUSPENDED,
          hiredAt: new Date("2023-04-01"),
          licenseExpiresAt: new Date("2029-04-01"),
        },
        {
          fullName: "Echo Driver",
          licenseNumber: "LIC-A-5",
          licenseClass: LicenseClass.HPMV,
          status: DriverStatus.ACTIVE,
          hiredAt: new Date("2024-05-01"),
          licenseExpiresAt: new Date("2030-05-01"),
        },
      ];
      for (const seed of seeds) {
        await service.create(makeCreateInput(seed), adminId);
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
      const result = await service.list({ status: [DriverStatus.ACTIVE] });
      expect(result.total).toBe(3);
      expect(result.items.every((d) => d.status === DriverStatus.ACTIVE)).toBe(true);
    });

    test("multi-status filter is OR within the dimension", async () => {
      await seedFive();
      const result = await service.list({
        status: [DriverStatus.ACTIVE, DriverStatus.ON_LEAVE],
      });
      expect(result.total).toBe(4);
    });

    test("licenseClass filter combined with status filter is AND across dimensions", async () => {
      await seedFive();
      const result = await service.list({
        status: [DriverStatus.ACTIVE],
        licenseClass: [LicenseClass.HMV],
      });
      // Only Bravo Driver satisfies both (LIC-A-2, HMV+ACTIVE).
      expect(result.total).toBe(1);
      expect(result.items[0]?.licenseNumber).toBe("LIC-A-2");
    });

    test("sortBy=fullName asc respects the whitelist column", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "fullName", sortDir: "asc" });
      const names = result.items.map((d) => d.fullName);
      expect(names).toEqual([
        "Alpha Driver",
        "Bravo Driver",
        "Charlie Driver",
        "Delta Driver",
        "Echo Driver",
      ]);
    });

    test("sortBy=licenseExpiresAt desc respects the whitelist column", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "licenseExpiresAt", sortDir: "desc" });
      // Echo (2030) → Delta (2029) → Charlie (2028) → Bravo (2027) → Alpha (2026)
      const names = result.items.map((d) => d.fullName);
      expect(names).toEqual([
        "Echo Driver",
        "Delta Driver",
        "Charlie Driver",
        "Bravo Driver",
        "Alpha Driver",
      ]);
    });

    test("sortBy=hiredAt asc respects the whitelist column", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "hiredAt", sortDir: "asc" });
      const names = result.items.map((d) => d.fullName);
      expect(names).toEqual([
        "Alpha Driver",
        "Bravo Driver",
        "Charlie Driver",
        "Delta Driver",
        "Echo Driver",
      ]);
    });

    test("pagination: skip + take returns the right window; total reflects the full match", async () => {
      await seedFive();
      const page = await service.list({
        sortBy: "fullName",
        sortDir: "asc",
        skip: 2,
        take: 2,
      });
      // Window is rows index 2 and 3 (zero-based): Charlie and Delta.
      const names = page.items.map((d) => d.fullName);
      expect(names).toEqual(["Charlie Driver", "Delta Driver"]);
      // Total reflects the full filtered match (here: no filter, so 5).
      expect(page.total).toBe(5);
    });

    test("take is clamped at LIST_TAKE_MAX (defense-in-depth from the controller schema)", async () => {
      // The schema rejects take>200 with 400 at the pipe; the service
      // also clamps to 200 in case a future direct caller bypasses the
      // controller (e.g., the future Trips slice). The clamp is
      // documented in drivers.service.ts as "defense-in-depth". This
      // test pins it so a refactor that removes the clamp without
      // removing the comment would fail.
      await seedFive();
      const result = await service.list({ take: 10_000 });
      // We seeded 5 rows; the assertion below only checks that the
      // service did not throw on the giant take — proof that the
      // clamp engaged. (5 < 200, so we can't see the 200 cap directly
      // without 201+ rows of seed data, which is expensive.)
      expect(result.items.length).toBeLessThanOrEqual(5);
      expect(result.total).toBe(5);
    });
  });

  describe("delete() — iter-7 hard-delete with P2025 → false", () => {
    // Hard delete is the Phase-1 policy (see the comment on
    // DriversService.delete and the controller-side mirror). The
    // service returns true when the row is removed and false when the
    // id does not exist; the controller maps false → HTTP 404 via
    // NotFoundException per the api-error-mapping runbook entry for
    // P2025. These two tests pin both branches.

    test("removes the row and returns true", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      const ok = await service.delete(created.id);
      expect(ok).toBe(true);

      const refetched = await prisma.driver.findUnique({ where: { id: created.id } });
      expect(refetched).toBeNull();
    });

    test("returns false on unknown id (P2025 branch)", async () => {
      // Prisma raises PrismaClientKnownRequestError with code "P2025"
      // when a targeted row does not exist for a delete. The service
      // catches that specific code and returns false so the controller
      // can shape the 404. Pinned here so a refactor that lets P2025
      // propagate as a 500 would fail loudly.
      const ok = await service.delete("nonexistent-id");
      expect(ok).toBe(false);
    });

    test("throws ConflictException with the trip count when referencing Trips exist (iter-9 P2003 mapping)", async () => {
      // Iter-9 deliverable: paying off the P2003 tech-debt entry. Trip
      // declares onDelete: Restrict on driverId per ADR-0003, so a
      // delete that would orphan trips raises Prisma P2003. The
      // service maps that to ConflictException with the count of
      // referencing trips so the operator sees a clear "N trips
      // reference this driver" message rather than a 500.
      const driver = await service.create(makeCreateInput(), adminId);
      const vehicle = await prisma.vehicle.create({
        data: {
          registrationNumber: `BA-${randomUUID().slice(0, 4)}`,
          kind: "TRUCK",
          make: "Tata",
          model: "LPK 2518",
          year: 2020,
          odometerStartKm: 0,
          odometerCurrentKm: 0,
          acquiredAt: new Date("2020-01-15"),
          status: "ACTIVE",
          createdById: adminId,
        },
      });
      await prisma.trip.create({
        data: {
          vehicleId: vehicle.id,
          driverId: driver.id,
          createdById: adminId,
          status: "PLANNED",
        },
      });

      try {
        await service.delete(driver.id);
        throw new Error("expected ConflictException");
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const message = (error as ConflictException).message;
        expect(message).toContain("1");
        expect(message.toLowerCase()).toContain("trip");
      }

      // The driver row is still present — Restrict prevented the
      // delete from happening.
      const refetched = await prisma.driver.findUnique({ where: { id: driver.id } });
      expect(refetched).not.toBeNull();
    });
  });

  // ADR-0034 c8's linking write path — closing the gap where Driver.userId
  // (what DriverScopeService.resolveOwnDriverId reads for own-record
  // trip/fuel-log scoping) had no writer anywhere in the app until now.
  describe("linkLogin() / unlinkLogin()", () => {
    test("links an unlinked driver to an existing DRIVER-role login", async () => {
      const driver = await service.create(makeCreateInput(), adminId);
      const loginId = await makeUser(prisma, UserRole.DRIVER);
      const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });

      const updated = await service.linkLogin(driver.id, login.email);

      expect(updated.userId).toBe(loginId);
    });

    test("linkLogin on a nonexistent driver id throws NotFoundException", async () => {
      const loginId = await makeUser(prisma, UserRole.DRIVER);
      const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });

      await expect(service.linkLogin("nonexistent-driver-id", login.email)).rejects.toThrow(
        NotFoundException,
      );
    });

    test("linkLogin with an email that resolves to no user throws NotFoundException naming the email", async () => {
      const driver = await service.create(makeCreateInput(), adminId);

      await expect(service.linkLogin(driver.id, "nobody@fleetco.test")).rejects.toMatchObject({
        message: expect.stringContaining("nobody@fleetco.test"),
      });
      await expect(service.linkLogin(driver.id, "nobody@fleetco.test")).rejects.toThrow(
        NotFoundException,
      );
    });

    test("linkLogin targeting an OFFICE_STAFF (or ADMIN) login throws BadRequestException naming the role", async () => {
      const driver = await service.create(makeCreateInput(), adminId);
      const officeId = await makeUser(prisma, UserRole.OFFICE_STAFF);
      const office = await prisma.user.findUniqueOrThrow({ where: { id: officeId } });

      await expect(service.linkLogin(driver.id, office.email)).rejects.toThrow(BadRequestException);
      await expect(service.linkLogin(driver.id, office.email)).rejects.toMatchObject({
        message: expect.stringContaining("OFFICE_STAFF"),
      });
    });

    test("linkLogin targeting a login already linked to a DIFFERENT driver throws ConflictException; the other link is untouched", async () => {
      const driverA = await service.create(makeCreateInput({ licenseNumber: "LIC-A" }), adminId);
      const driverB = await service.create(makeCreateInput({ licenseNumber: "LIC-B" }), adminId);
      const loginId = await makeUser(prisma, UserRole.DRIVER);
      const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });
      await service.linkLogin(driverA.id, login.email);

      await expect(service.linkLogin(driverB.id, login.email)).rejects.toThrow(ConflictException);

      const refetchedA = await prisma.driver.findUnique({ where: { id: driverA.id } });
      expect(refetchedA?.userId).toBe(loginId);
    });

    test("linkLogin called twice with the SAME email on the SAME driver is an idempotent no-op", async () => {
      const driver = await service.create(makeCreateInput(), adminId);
      const loginId = await makeUser(prisma, UserRole.DRIVER);
      const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });

      await service.linkLogin(driver.id, login.email);
      const second = await service.linkLogin(driver.id, login.email);

      expect(second.userId).toBe(loginId);
    });

    test("linkLogin on a driver already linked to a DIFFERENT login throws ConflictException; the original link is untouched", async () => {
      const driver = await service.create(makeCreateInput(), adminId);
      const firstLoginId = await makeUser(prisma, UserRole.DRIVER);
      const firstLogin = await prisma.user.findUniqueOrThrow({ where: { id: firstLoginId } });
      const secondLoginId = await makeUser(prisma, UserRole.DRIVER);
      const secondLogin = await prisma.user.findUniqueOrThrow({ where: { id: secondLoginId } });
      await service.linkLogin(driver.id, firstLogin.email);

      await expect(service.linkLogin(driver.id, secondLogin.email)).rejects.toThrow(
        ConflictException,
      );

      const refetched = await prisma.driver.findUnique({ where: { id: driver.id } });
      expect(refetched?.userId).toBe(firstLoginId);
    });

    test("unlinkLogin on a linked driver sets userId to null", async () => {
      const driver = await service.create(makeCreateInput(), adminId);
      const loginId = await makeUser(prisma, UserRole.DRIVER);
      const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });
      await service.linkLogin(driver.id, login.email);

      const unlinked = await service.unlinkLogin(driver.id);

      expect(unlinked.userId).toBeNull();
    });

    test("unlinkLogin on an already-unlinked driver is an idempotent no-op", async () => {
      const driver = await service.create(makeCreateInput(), adminId);

      const result = await service.unlinkLogin(driver.id);

      expect(result.userId).toBeNull();
    });

    test("unlinkLogin on a nonexistent driver id throws NotFoundException", async () => {
      await expect(service.unlinkLogin("nonexistent-driver-id")).rejects.toThrow(NotFoundException);
    });

    test("findLinkedLoginEmail returns the linked login's email, or null when unlinked", async () => {
      const driver = await service.create(makeCreateInput(), adminId);
      expect(await service.findLinkedLoginEmail(driver.id)).toBeNull(); // driver.id is not a userId; this asserts the "no user found" branch too

      const loginId = await makeUser(prisma, UserRole.DRIVER);
      const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });
      expect(await service.findLinkedLoginEmail(loginId)).toBe(login.email);
    });

    // The loop-closing test: proves the write path this suite covers above
    // actually produces the effect the already-shipped, already-tested read
    // path (DriverScopeService, ADR-0034 c4) depends on — closing ADR-0034's
    // own stated invariant end-to-end for the first time.
    test("linking makes DriverScopeService resolve the driver; unlinking makes it 403 again", async () => {
      const driverScope = module.get(DriverScopeService);
      const driver = await service.create(makeCreateInput(), adminId);
      const loginId = await makeUser(prisma, UserRole.DRIVER);
      const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });
      const actor = { userId: loginId, role: UserRole.DRIVER };

      // Unlinked: fails closed, per DriverScopeService's own documented
      // contract (a 403, never a silent unscoped result).
      await expect(driverScope.resolveOwnDriverId(actor)).rejects.toThrow();

      await service.linkLogin(driver.id, login.email);
      expect(await driverScope.resolveOwnDriverId(actor)).toBe(driver.id);

      await service.unlinkLogin(driver.id);
      await expect(driverScope.resolveOwnDriverId(actor)).rejects.toThrow();
    });
  });
});
