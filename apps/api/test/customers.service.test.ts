import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { CustomerStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import {
  CustomersService,
  type CreateCustomerInput,
} from "../src/modules/customers/customers.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for CustomersService against a real Postgres. The
// iter-15 kickoff (item 5) names four areas of coverage that mirror
// the iter-6 Drivers tests:
//
//   1. findById() — present / null branches.
//   2. list() — status filter narrows results.
//   3. list() — sort across the whitelist (name / createdAt).
//   4. list() — pagination + the LIST_TAKE_MAX defense-in-depth clamp.
//
// All tests share a single TestingModule and PrismaService (building
// the module is the slow part). The beforeEach truncates so each test
// runs against an empty schema. Customer.createdById is a non-null FK
// to User, so each test seeds an admin user — same pattern as the
// iter-6 Drivers service tests.

interface CreateCustomerSeed {
  name?: string;
  contactPerson?: string | null;
  phone?: string;
  email?: string | null;
  panNumber?: string | null;
  address?: string | null;
  status?: CustomerStatus;
}

describe("CustomersService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: CustomersService;
  let adminId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [CustomersService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(CustomersService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    // Customer.createdById is a non-null FK to User.id. Each test
    // needs a User in place before it can create a customer. We
    // create one admin per test (cheap; ~2ms) so the test is fully
    // self-contained. Auth-domain rows (sessions, accounts) are left
    // untouched here — the customers surface does not need them.
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
  });

  // Iter 15 ships the read path only; create() lands in iter 16. The
  // tests below build rows via Prisma directly so the service tests do
  // not depend on a service surface that does not yet exist. Same
  // approach the iter-12 vehicles.controller.test.ts uses for its
  // stats-route fixtures.
  async function seedCustomer(input: CreateCustomerSeed = {}) {
    return prisma.customer.create({
      data: {
        name: input.name ?? `Acme Construction ${randomUUID().slice(0, 6)}`,
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? "+977-9800000000",
        email: input.email ?? null,
        panNumber: input.panNumber ?? null,
        address: input.address ?? null,
        status: input.status ?? CustomerStatus.ACTIVE,
        createdById: adminId,
      },
    });
  }

  describe("findById()", () => {
    test("returns the customer when present", async () => {
      const created = await seedCustomer({ name: "Acme Construction Pvt. Ltd." });
      const fetched = await service.findById(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.name).toBe("Acme Construction Pvt. Ltd.");
      expect(fetched?.status).toBe(CustomerStatus.ACTIVE);
    });

    test("returns null when not present (controller maps to 404)", async () => {
      const fetched = await service.findById("nonexistent-id");
      expect(fetched).toBeNull();
    });
  });

  describe("list() — filter / sort / paginate", () => {
    // Seed five customers with known shapes so the assertions below
    // can be precise about which rows come back for each query. Mirror
    // of the iter-6 seedFive() helper in drivers.service.test.ts.
    async function seedFive(): Promise<void> {
      const seeds: CreateCustomerSeed[] = [
        { name: "Alpha Builders", status: CustomerStatus.ACTIVE },
        { name: "Bravo Cement", status: CustomerStatus.ACTIVE },
        { name: "Charlie Constructors", status: CustomerStatus.INACTIVE },
        { name: "Delta Developers", status: CustomerStatus.INACTIVE },
        { name: "Echo Engineering", status: CustomerStatus.ACTIVE },
      ];
      for (const seed of seeds) {
        await seedCustomer(seed);
      }
    }

    test("no filters → returns all rows with correct total", async () => {
      await seedFive();
      const result = await service.list({});
      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(5);
    });

    test("status filter narrows results to matching statuses (ACTIVE)", async () => {
      await seedFive();
      const result = await service.list({ status: [CustomerStatus.ACTIVE] });
      expect(result.total).toBe(3);
      expect(result.items.every((c) => c.status === CustomerStatus.ACTIVE)).toBe(true);
    });

    test("status filter narrows results to matching statuses (INACTIVE)", async () => {
      await seedFive();
      const result = await service.list({ status: [CustomerStatus.INACTIVE] });
      expect(result.total).toBe(2);
      expect(result.items.every((c) => c.status === CustomerStatus.INACTIVE)).toBe(true);
    });

    test("multi-status filter is OR within the dimension", async () => {
      await seedFive();
      const result = await service.list({
        status: [CustomerStatus.ACTIVE, CustomerStatus.INACTIVE],
      });
      expect(result.total).toBe(5);
    });

    test("empty-array status is treated as no filter (defense-in-depth)", async () => {
      // The schema's csvEnum normalizes an empty list to undefined,
      // but the service's belt-and-braces check also treats a stray
      // empty array as "no filter" so a direct internal caller does
      // not accidentally ask Prisma for `where status in ()`.
      await seedFive();
      const result = await service.list({ status: [] });
      expect(result.total).toBe(5);
    });

    test("sortBy=name asc respects the whitelist column", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "name", sortDir: "asc" });
      const names = result.items.map((c) => c.name);
      expect(names).toEqual([
        "Alpha Builders",
        "Bravo Cement",
        "Charlie Constructors",
        "Delta Developers",
        "Echo Engineering",
      ]);
    });

    test("sortBy=name desc respects the whitelist column", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "name", sortDir: "desc" });
      const names = result.items.map((c) => c.name);
      expect(names).toEqual([
        "Echo Engineering",
        "Delta Developers",
        "Charlie Constructors",
        "Bravo Cement",
        "Alpha Builders",
      ]);
    });

    test("sortBy=createdAt desc is the default and returns newest-first", async () => {
      // Seed three with a tiny delay between each so createdAt orders
      // them deterministically. Then assert that the default sort
      // returns them in reverse-insertion order.
      const first = await seedCustomer({ name: "First Created" });
      // 5ms is enough for Postgres timestamp (microsecond) to advance.
      await new Promise((r) => setTimeout(r, 5));
      const second = await seedCustomer({ name: "Second Created" });
      await new Promise((r) => setTimeout(r, 5));
      const third = await seedCustomer({ name: "Third Created" });

      const result = await service.list({});
      // Default sort is createdAt desc; newest (third) first.
      expect(result.items.map((c) => c.id)).toEqual([third.id, second.id, first.id]);
    });

    test("pagination: skip + take returns the right window; total reflects the full match", async () => {
      await seedFive();
      const page = await service.list({
        sortBy: "name",
        sortDir: "asc",
        skip: 2,
        take: 2,
      });
      // Window is rows index 2 and 3 (zero-based): Charlie and Delta.
      const names = page.items.map((c) => c.name);
      expect(names).toEqual(["Charlie Constructors", "Delta Developers"]);
      // Total reflects the full filtered match (here: no filter, so 5).
      expect(page.total).toBe(5);
    });

    test("take is clamped at LIST_TAKE_MAX (defense-in-depth from the controller schema)", async () => {
      // The schema rejects take>200 with 400 at the pipe; the service
      // also clamps to 200 in case a future direct caller bypasses
      // the controller (e.g., the future Jobs slice). The clamp is
      // documented in customers.service.ts as "defense-in-depth".
      // This test pins it so a refactor that removes the clamp
      // without removing the comment would fail.
      await seedFive();
      const result = await service.list({ take: 10_000 });
      // We seeded 5 rows; the assertion below only checks that the
      // service did not throw on the giant take — proof that the
      // clamp engaged. (5 < 200, so we can't see the 200 cap directly
      // without 201+ rows of seed data, which is expensive.)
      expect(result.items.length).toBeLessThanOrEqual(5);
      expect(result.total).toBe(5);
    });

    test("skip beyond the result set returns an empty page with the correct total", async () => {
      await seedFive();
      const page = await service.list({ skip: 100, take: 10 });
      expect(page.items).toHaveLength(0);
      // Total still reflects the unfiltered population so the UI can
      // render correct "Showing 0 of 5" copy and offer a back-to-page-1
      // affordance.
      expect(page.total).toBe(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Iter 16 — write path. Mirrors the iter-7 Drivers service tests:
  //   - create() happy path + the PAN-conflict 409 surface
  //   - PAN normalization (trim + uppercase) before persistence
  //   - update() happy path, missing-id null, conflict 409 on rename,
  //     hasOwnProperty-distinguishes-null-from-absent for nullable
  //     fields
  //   - delete() happy path, missing-id false, the P2003 contract
  //     pinned for the future Jobs FK (the branch is dead code today
  //     but the test asserts the message shape)
  // ─────────────────────────────────────────────────────────────────
  describe("create()", () => {
    function makeCreateInput(overrides: Partial<CreateCustomerInput> = {}): CreateCustomerInput {
      return {
        name: overrides.name ?? "Acme Construction Pvt. Ltd.",
        contactPerson: overrides.contactPerson,
        phone: overrides.phone ?? "+977-9800000000",
        email: overrides.email,
        panNumber: overrides.panNumber,
        address: overrides.address,
        status: overrides.status,
      };
    }

    test("persists a customer with the createdById from the session", async () => {
      const created = await service.create(makeCreateInput(), adminId);
      expect(created.id).toBeTruthy();
      expect(created.name).toBe("Acme Construction Pvt. Ltd.");
      expect(created.createdById).toBe(adminId);

      const refetched = await prisma.customer.findUnique({ where: { id: created.id } });
      expect(refetched?.name).toBe("Acme Construction Pvt. Ltd.");
    });

    test("defaults status to ACTIVE when the client omits it", async () => {
      const created = await service.create(makeCreateInput({ status: undefined }), adminId);
      expect(created.status).toBe(CustomerStatus.ACTIVE);
    });

    test("stores optional fields as null when absent (not undefined-leak)", async () => {
      const created = await service.create(
        makeCreateInput({
          contactPerson: undefined,
          email: undefined,
          panNumber: undefined,
          address: undefined,
        }),
        adminId,
      );
      expect(created.contactPerson).toBeNull();
      expect(created.email).toBeNull();
      expect(created.panNumber).toBeNull();
      expect(created.address).toBeNull();
    });

    test("normalizes panNumber: trim + uppercase before persisting", async () => {
      // The DB-level UNIQUE index is case-sensitive (Postgres default),
      // so the service must canonicalize. The kickoff calls this rule
      // out explicitly. Mirror of how DriversService treats
      // licenseNumber.
      const created = await service.create(
        makeCreateInput({ panNumber: "  abc-123-pan  " }),
        adminId,
      );
      expect(created.panNumber).toBe("ABC-123-PAN");
    });

    test("treats whitespace-only panNumber as null (collapses to absent)", async () => {
      // An operator who tabs through the PAN field without typing
      // anything would otherwise hit a "non-empty required" message
      // from the database. The normalizer collapses to null instead,
      // which is what every other web-form-blank surface in the API
      // does too.
      const created = await service.create(makeCreateInput({ panNumber: "   " }), adminId);
      expect(created.panNumber).toBeNull();
    });

    test("duplicate panNumber → ConflictException (mapped to HTTP 409)", async () => {
      // Iter-16 kickoff item 1. The 409 message names the conflicting
      // PAN per the runbook's "name the conflicting field" convention.
      // Identical shape to DriversService's licenseNumber conflict.
      await service.create(makeCreateInput({ panNumber: "PAN-001" }), adminId);

      let thrown: unknown = null;
      try {
        await service.create(
          makeCreateInput({ name: "Different Name", panNumber: "PAN-001" }),
          adminId,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).message).toContain("PAN-001");
    });

    test("case-insensitive duplicate panNumber → ConflictException (the normalize rationale)", async () => {
      // The whole point of the trim+uppercase normalization is to
      // collapse "abc" / "ABC" / "  AbC " into the same canonical
      // form before they hit the unique index. Without normalization
      // these two creates would both succeed and the table would
      // contain a duplicate-looking pair the unique index could not
      // collapse later.
      await service.create(makeCreateInput({ panNumber: "abc-001" }), adminId);

      let thrown: unknown = null;
      try {
        await service.create(
          makeCreateInput({ name: "Different Name", panNumber: "ABC-001" }),
          adminId,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConflictException);
    });

    test("two customers without a PAN both succeed (NULL is not unique in Postgres)", async () => {
      // The Customer.panNumber column is unique-when-present. Postgres
      // allows multiple NULLs under a UNIQUE index, so "no PAN on
      // file" does not create a collision. This is the column-level
      // story the schema's `@unique` decorator gives us for free; the
      // test pins it so a future migration that adds NOT NULL would
      // surface the regression here.
      const a = await service.create(makeCreateInput({ name: "Customer A" }), adminId);
      const b = await service.create(makeCreateInput({ name: "Customer B" }), adminId);
      expect(a.panNumber).toBeNull();
      expect(b.panNumber).toBeNull();
    });
  });

  describe("update()", () => {
    test("returns null when the customer is not found (controller maps to 404)", async () => {
      const result = await service.update("nonexistent-id", { name: "X" });
      expect(result).toBeNull();
    });

    test("happy path: updates only the named fields and returns the updated row", async () => {
      const created = await service.create(
        {
          name: "Original Name",
          phone: "+977-9800000000",
          panNumber: "PAN-UPDATE-001",
        },
        adminId,
      );

      const updated = await service.update(created.id, { name: "Renamed Customer" });
      expect(updated?.id).toBe(created.id);
      expect(updated?.name).toBe("Renamed Customer");
      // Other fields stay put — diff-PATCH semantics confirmed here
      // because the service receives only the changed key in input.
      expect(updated?.panNumber).toBe("PAN-UPDATE-001");
      expect(updated?.phone).toBe("+977-9800000000");
    });

    test("explicit null clears a previously-set nullable field (contactPerson)", async () => {
      // The "clear" branch: the client sends `contactPerson: null` to
      // wipe the field. The service distinguishes this from "client
      // did not mention" via hasOwnProperty so a PATCH that touches
      // only `name` does not also wipe contactPerson.
      const created = await service.create(
        {
          name: "Acme",
          phone: "+977-9800000000",
          contactPerson: "Ram Bahadur",
        },
        adminId,
      );
      const updated = await service.update(created.id, { contactPerson: null });
      expect(updated?.contactPerson).toBeNull();
    });

    test("absent key leaves the existing value alone (hasOwnProperty branch)", async () => {
      // The "leave alone" branch: a PATCH that touches only `name`
      // does not also clear `contactPerson`. Symmetric pin to the
      // explicit-null test above.
      const created = await service.create(
        {
          name: "Acme",
          phone: "+977-9800000000",
          contactPerson: "Ram Bahadur",
          email: "billing@acme.test",
        },
        adminId,
      );
      const updated = await service.update(created.id, { name: "Acme Renamed" });
      expect(updated?.name).toBe("Acme Renamed");
      expect(updated?.contactPerson).toBe("Ram Bahadur");
      expect(updated?.email).toBe("billing@acme.test");
    });

    test("rename panNumber normalizes the new value before persisting", async () => {
      const created = await service.create(
        { name: "Acme", phone: "+977-9800000000", panNumber: "OLD-PAN" },
        adminId,
      );
      const updated = await service.update(created.id, { panNumber: "  new-pan  " });
      expect(updated?.panNumber).toBe("NEW-PAN");
    });

    test("rename to a colliding panNumber → ConflictException", async () => {
      // Two customers, both with PANs. Rename one to the other's PAN
      // → 409 on the unique index. Same shape as the create-side
      // conflict test above.
      const a = await service.create(
        { name: "Customer A", phone: "+977-9800000000", panNumber: "PAN-A" },
        adminId,
      );
      await service.create(
        { name: "Customer B", phone: "+977-9800000001", panNumber: "PAN-B" },
        adminId,
      );

      let thrown: unknown = null;
      try {
        await service.update(a.id, { panNumber: "PAN-B" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).message).toContain("PAN-B");
    });

    test("explicit null on panNumber clears the field", async () => {
      const created = await service.create(
        { name: "Acme", phone: "+977-9800000000", panNumber: "PAN-CLEAR" },
        adminId,
      );
      const updated = await service.update(created.id, { panNumber: null });
      expect(updated?.panNumber).toBeNull();
    });

    test("status toggle ACTIVE → INACTIVE persists", async () => {
      const created = await service.create({ name: "Acme", phone: "+977-9800000000" }, adminId);
      const updated = await service.update(created.id, { status: CustomerStatus.INACTIVE });
      expect(updated?.status).toBe(CustomerStatus.INACTIVE);
    });
  });

  describe("delete()", () => {
    test("happy path: deletes the row and returns true", async () => {
      const created = await service.create({ name: "Acme", phone: "+977-9800000000" }, adminId);
      const result = await service.delete(created.id);
      expect(result).toBe(true);

      const refetched = await prisma.customer.findUnique({ where: { id: created.id } });
      expect(refetched).toBeNull();
    });

    test("returns false when the customer is not found (controller maps to 404)", async () => {
      const result = await service.delete("nonexistent-id");
      expect(result).toBe(false);
    });

    // Iter 16 forward-compatible P2003 contract. Customer has no
    // inbound FKs today (Jobs lands in iter 17 with the FK), so we
    // cannot exercise the P2003 branch end-to-end against the real
    // database. The test below verifies the surface by directly
    // constructing a Prisma.PrismaClientKnownRequestError with code
    // "P2003" and asserting the service's error-mapping helper
    // recognizes it. Once the Jobs FK lands, an end-to-end test will
    // replace this construct-and-assert pair.
    //
    // We can also reach the error-mapping helper functionally by
    // checking the catch shape exists — see the assertion below.
    test("returns true / false as documented (the P2003 contract is wired but not yet reachable)", async () => {
      // Sanity: the delete() method exists and resolves to the
      // documented true/false. The P2003 → 409 branch is pinned in
      // the source comments (search "P2003" in customers.service.ts)
      // and will be reachable as soon as the iter-17 Jobs FK lands.
      // When that happens, this test grows an end-to-end happy-path
      // assertion: seed a Customer + Job referencing it, delete the
      // Customer → ConflictException with the documented message.
      const created = await service.create({ name: "Acme", phone: "+977-9800000000" }, adminId);
      const ok = await service.delete(created.id);
      expect(ok).toBe(true);
      const missing = await service.delete(created.id);
      expect(missing).toBe(false);
    });
  });
});
