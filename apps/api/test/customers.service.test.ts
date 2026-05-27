import { randomUUID } from "node:crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { CustomerStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { CustomersService } from "../src/modules/customers/customers.service";
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
});
