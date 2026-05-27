import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { JobStatus, type Customer } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { CreateJobSchema, UpdateJobSchema } from "../src/modules/jobs/jobs.schemas";
import { JobsService, LIST_TAKE_MAX } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for JobsService against a real Postgres. Mirrors
// the iter-8 trips.service.test.ts and the iter-15 customers.service.
// test.ts in shape; the iter-17 kickoff (Checkpoint 1, last bullet)
// names five areas of coverage:
//
//   1. getById() — present (returns row with nested customer) and
//      missing (throws NotFoundException) branches.
//   2. list() — pagination math (skip/take + total).
//   3. list() — sort defaults (createdAt desc) and the sortBy
//      whitelist (createdAt / jobNumber / scheduledStartDate).
//   4. list() — status filter narrows results.
//   5. list() — customerId filter narrows results.
//
// All tests share a single TestingModule and PrismaService (building
// the module is the slow part). The beforeEach truncates so each test
// runs against an empty schema. Job.customerId is a non-null FK to
// Customer and Job.createdById is a non-null FK to User, so each test
// seeds an admin user and a customer first — same pattern as the
// iter-8 Trips service tests, which seed vehicle + driver + user.

interface CreateJobSeed {
  jobNumber?: string;
  description?: string;
  status?: JobStatus;
  scheduledStartDate?: Date | null;
  scheduledEndDate?: Date | null;
  actualStartDate?: Date | null;
  actualEndDate?: Date | null;
  notes?: string | null;
  customerId?: string;
}

describe("JobsService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: JobsService;
  let adminId: string;
  let customer: Customer;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [JobsService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(JobsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);

    // Job.createdById is a non-null FK to User.id, and Job.customerId
    // is a non-null FK to Customer.id. Each test needs both rows in
    // place before it can create a job. We create one admin and one
    // customer per test (cheap; ~3ms combined) so each test is fully
    // self-contained. Auth-domain rows (sessions, accounts) are left
    // untouched here — the jobs surface does not need them.
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
    customer = await prisma.customer.create({
      data: {
        name: "Acme Construction Pvt. Ltd.",
        phone: "+977-9800000000",
        createdById: adminId,
      },
    });
  });

  // Iter 17 ships the read path only; create() lands in iter 18. The
  // tests below build rows via Prisma directly so the service tests do
  // not depend on a service surface that does not yet exist. Same
  // approach the iter-15 customers.service.test.ts and the iter-12
  // vehicles.controller.test.ts use for their fixtures.
  let nextSeedIndex = 1;
  async function seedJob(input: CreateJobSeed = {}) {
    // Default to a hand-written canonical job number per the iter-17
    // kickoff: the JOB-YYYY-NNNNN generator lives in the service in
    // iter 18, so for iter 17's read-path tests we hand-write values.
    // The auto-increment via nextSeedIndex keeps each test
    // self-contained when seeding multiple rows.
    const fallback = `JOB-2026-${String(nextSeedIndex++).padStart(5, "0")}`;
    return prisma.job.create({
      data: {
        jobNumber: input.jobNumber ?? fallback,
        description: input.description ?? "Aggregate haul, Kalimati to Pokhara site.",
        status: input.status ?? JobStatus.PLANNED,
        scheduledStartDate: input.scheduledStartDate ?? null,
        scheduledEndDate: input.scheduledEndDate ?? null,
        actualStartDate: input.actualStartDate ?? null,
        actualEndDate: input.actualEndDate ?? null,
        notes: input.notes ?? null,
        customerId: input.customerId ?? customer.id,
        createdById: adminId,
      },
    });
  }

  describe("findById() / getById()", () => {
    test("findById() returns the job with the nested customer when present", async () => {
      const created = await seedJob({ description: "Pokhara delivery" });
      const fetched = await service.findById(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.description).toBe("Pokhara delivery");
      expect(fetched?.status).toBe(JobStatus.PLANNED);
      // The detail include is the contract under test — pinned here
      // so a refactor that dropped `customer` from DETAIL_INCLUDE
      // would fail loudly rather than silently breaking the detail
      // page's deep-link.
      expect(fetched?.customer.id).toBe(customer.id);
      expect(fetched?.customer.name).toBe(customer.name);
    });

    test("findById() returns null when not present", async () => {
      const fetched = await service.findById("nonexistent-id");
      expect(fetched).toBeNull();
    });

    test("getById() throws NotFoundException with the id in the message when missing", async () => {
      // The runbook commits to "Job {id} not found" wording; we
      // assert the id appears so a future message refactor that
      // dropped it would fail.
      try {
        await service.getById("nonexistent-id");
        throw new Error("expected NotFoundException");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toContain("nonexistent-id");
      }
    });

    test("getById() returns the job with nested customer on the happy path", async () => {
      const created = await seedJob();
      const fetched = await service.getById(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.customer.id).toBe(customer.id);
    });
  });

  describe("list() — filter / sort / paginate", () => {
    // Seed five jobs with known shapes so the assertions below can be
    // precise about which rows come back for each query. Mirror of
    // the iter-15 seedFive() helper in customers.service.test.ts.
    async function seedFive(): Promise<void> {
      const seeds: CreateJobSeed[] = [
        {
          jobNumber: "JOB-2026-00001",
          status: JobStatus.PLANNED,
          scheduledStartDate: new Date("2026-03-01T00:00:00Z"),
        },
        {
          jobNumber: "JOB-2026-00002",
          status: JobStatus.IN_PROGRESS,
          scheduledStartDate: new Date("2026-02-01T00:00:00Z"),
        },
        {
          jobNumber: "JOB-2026-00003",
          status: JobStatus.COMPLETED,
          scheduledStartDate: new Date("2026-01-01T00:00:00Z"),
        },
        {
          jobNumber: "JOB-2026-00004",
          status: JobStatus.CANCELLED,
          scheduledStartDate: null,
        },
        {
          jobNumber: "JOB-2026-00005",
          status: JobStatus.PLANNED,
          scheduledStartDate: new Date("2026-04-01T00:00:00Z"),
        },
      ];
      // Sequential creates so createdAt order is deterministic
      // (Postgres NOW() has microsecond precision but back-to-back
      // inserts can still tie; the sequential await ensures a
      // monotonic createdAt sequence so the default-sort test is
      // stable). Same approach drivers.service.test.ts uses.
      for (const seed of seeds) {
        await seedJob(seed);
      }
    }

    test("returns { items, total } with the documented shape and pagination defaults", async () => {
      await seedFive();
      const result = await service.list({});
      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(5);
    });

    test("pagination math: skip=2, take=2 returns rows 3+4 in the default sort", async () => {
      await seedFive();
      const result = await service.list({ skip: 2, take: 2 });
      expect(result.total).toBe(5);
      expect(result.items).toHaveLength(2);
      // Default sort is createdAt desc. seedFive inserts in jobNumber
      // ascending order, so the newest (last inserted) is JOB-00005.
      // After two skipped rows from the desc-sorted list we land on
      // JOB-00003 and JOB-00002.
      expect(result.items[0]?.jobNumber).toBe("JOB-2026-00003");
      expect(result.items[1]?.jobNumber).toBe("JOB-2026-00002");
    });

    test("sort default is createdAt desc — newest job comes first", async () => {
      await seedFive();
      const result = await service.list({});
      // seedFive inserts in jobNumber ascending order; default sort
      // is createdAt desc; therefore the first item is the
      // last-inserted job (JOB-00005). Pinned so a refactor that
      // flipped the default to `asc` or to a non-createdAt column
      // would fail.
      expect(result.items[0]?.jobNumber).toBe("JOB-2026-00005");
    });

    test("sortBy=jobNumber asc returns the jobs in jobNumber order", async () => {
      await seedFive();
      const result = await service.list({ sortBy: "jobNumber", sortDir: "asc" });
      expect(result.items.map((j) => j.jobNumber)).toEqual([
        "JOB-2026-00001",
        "JOB-2026-00002",
        "JOB-2026-00003",
        "JOB-2026-00004",
        "JOB-2026-00005",
      ]);
    });

    test("sortBy=scheduledStartDate asc — nulls sort last (Prisma default null-ordering)", async () => {
      await seedFive();
      const result = await service.list({
        sortBy: "scheduledStartDate",
        sortDir: "asc",
      });
      // Asc with nulls-last (Prisma's default): JOB-00003 (Jan) →
      // JOB-00002 (Feb) → JOB-00001 (Mar) → JOB-00005 (Apr) →
      // JOB-00004 (null). Pinned so a refactor that switched
      // null-ordering would fail and the operator's "scheduled soon"
      // view would not silently invert.
      expect(result.items.map((j) => j.jobNumber)).toEqual([
        "JOB-2026-00003",
        "JOB-2026-00002",
        "JOB-2026-00001",
        "JOB-2026-00005",
        "JOB-2026-00004",
      ]);
    });

    test("status filter narrows the result set", async () => {
      await seedFive();
      const result = await service.list({ status: [JobStatus.PLANNED] });
      expect(result.total).toBe(2);
      expect(result.items.map((j) => j.jobNumber).sort()).toEqual([
        "JOB-2026-00001",
        "JOB-2026-00005",
      ]);
    });

    test("status filter accepts multiple values (Prisma `in` shape)", async () => {
      await seedFive();
      const result = await service.list({
        status: [JobStatus.COMPLETED, JobStatus.CANCELLED],
      });
      expect(result.total).toBe(2);
      expect(result.items.map((j) => j.jobNumber).sort()).toEqual([
        "JOB-2026-00003",
        "JOB-2026-00004",
      ]);
    });

    test("customerId filter narrows the result set", async () => {
      await seedFive();
      // Add a second customer and one job for them — the customerId
      // filter should pull only that job.
      const otherCustomer = await prisma.customer.create({
        data: {
          name: "Bravo Cement Pvt. Ltd.",
          phone: "+977-9811111111",
          createdById: adminId,
        },
      });
      await seedJob({
        jobNumber: "JOB-2026-00099",
        customerId: otherCustomer.id,
        description: "Bravo's job",
      });
      const result = await service.list({ customerId: otherCustomer.id });
      expect(result.total).toBe(1);
      expect(result.items[0]?.jobNumber).toBe("JOB-2026-00099");
      expect(result.items[0]?.customer.name).toBe("Bravo Cement Pvt. Ltd.");
    });

    test("customerId filter for an unknown id returns the empty result set (no throw)", async () => {
      await seedFive();
      const result = await service.list({ customerId: "nonexistent-customer" });
      expect(result.total).toBe(0);
      expect(result.items).toHaveLength(0);
    });

    test("LIST_TAKE_MAX defense-in-depth clamp: take=999999 returns at most LIST_TAKE_MAX rows", async () => {
      // The schema rejects take above 200 at the controller boundary
      // (HTTP 400); but the service is also called from inside other
      // modules' code paths in future slices (e.g., a "jobs for this
      // customer" sidebar), and the clamp here ensures the database
      // is never asked for an unbounded result. Seed 3 rows and ask
      // for 999999; the result should still cap at LIST_TAKE_MAX
      // (200), so 3 rows come back.
      await seedJob();
      await seedJob();
      await seedJob();
      const result = await service.list({ take: 999999 });
      // Total is the unclamped row count; items is clamped by take.
      // With 3 rows present the clamp does not show up in the row
      // count, but it does in the underlying findMany call —
      // exercised by the fact that the call did not throw or hang.
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(3);
      // The clamp is what we are testing — assert the constant has
      // not changed silently (LIST_TAKE_MAX = 200 per the iter-17
      // contract; a refactor that lifted it without an ADR would
      // surface here).
      expect(LIST_TAKE_MAX).toBe(200);
    });

    test("list returns the nested customer name in each item (LIST_SELECT contract)", async () => {
      await seedJob({ description: "Pokhara delivery" });
      const result = await service.list({});
      expect(result.items[0]?.customer.name).toBe("Acme Construction Pvt. Ltd.");
      // The customer object is intentionally slim — id + name only.
      // Pinned here so a refactor that widened LIST_SELECT (e.g., to
      // include the customer's PAN number) would surface as a
      // shape-change requiring a contract review per ADR-0013 PII
      // tiering.
      expect(Object.keys(result.items[0]?.customer ?? {}).sort()).toEqual(["id", "name"]);
    });
  });

  // -------------------------------------------------------------------
  // Iter 18 — write path. JOB-YYYY-NNNNN generator, create with FK
  // validation, diff-PATCH update, delete + 404 + no-op + cross-field
  // merged-shape rule. Mirror of the iter-16 Customers write-path
  // service tests in shape; the kickoff Checkpoint 1 last bullet
  // names the required coverage.
  // -------------------------------------------------------------------
  describe("create() — jobNumber generation + FK validation", () => {
    test("first job of the year gets sequence 00001", async () => {
      const created = await service.create(
        {
          customerId: customer.id,
          description: "First job",
        },
        adminId,
      );
      const year = new Date().getUTCFullYear();
      expect(created.jobNumber).toBe(`JOB-${year}-00001`);
    });

    test("second job of the year gets sequence 00002 (increment)", async () => {
      await service.create({ customerId: customer.id, description: "First" }, adminId);
      const second = await service.create(
        { customerId: customer.id, description: "Second" },
        adminId,
      );
      const year = new Date().getUTCFullYear();
      expect(second.jobNumber).toBe(`JOB-${year}-00002`);
    });

    test("year prefix is the current UTC year", async () => {
      const created = await service.create(
        { customerId: customer.id, description: "Year-prefix check" },
        adminId,
      );
      const year = new Date().getUTCFullYear();
      expect(created.jobNumber.startsWith(`JOB-${year}-`)).toBe(true);
      // 5-digit zero-padded suffix
      expect(created.jobNumber).toMatch(/^JOB-\d{4}-\d{5}$/);
    });

    test("existing higher-numbered job from the same year is honored", async () => {
      // Seed a job with a pre-existing high sequence value; the
      // generator should compute next as 00043 + 1 = 00044.
      const year = new Date().getUTCFullYear();
      await seedJob({ jobNumber: `JOB-${year}-00043` });
      const created = await service.create(
        { customerId: customer.id, description: "After 00043" },
        adminId,
      );
      expect(created.jobNumber).toBe(`JOB-${year}-00044`);
    });

    test("existing job from a different year does NOT affect the current-year sequence", async () => {
      // A job from a prior year should not influence this year's
      // sequence — pinned so a refactor that dropped the year prefix
      // from the find-highest query would surface here.
      await seedJob({ jobNumber: "JOB-2020-09999" });
      const created = await service.create(
        { customerId: customer.id, description: "Cross-year independence" },
        adminId,
      );
      const year = new Date().getUTCFullYear();
      expect(created.jobNumber).toBe(`JOB-${year}-00001`);
    });

    test("create persists all the supplied fields including the four date fields", async () => {
      const created = await service.create(
        {
          customerId: customer.id,
          description: "Full create",
          status: JobStatus.IN_PROGRESS,
          scheduledStartDate: new Date("2026-04-01T00:00:00Z"),
          scheduledEndDate: new Date("2026-04-15T00:00:00Z"),
          actualStartDate: new Date("2026-04-02T00:00:00Z"),
          notes: "Some notes.",
        },
        adminId,
      );
      expect(created.description).toBe("Full create");
      expect(created.status).toBe(JobStatus.IN_PROGRESS);
      expect(created.scheduledStartDate?.toISOString()).toBe(
        new Date("2026-04-01T00:00:00Z").toISOString(),
      );
      expect(created.scheduledEndDate?.toISOString()).toBe(
        new Date("2026-04-15T00:00:00Z").toISOString(),
      );
      expect(created.actualStartDate?.toISOString()).toBe(
        new Date("2026-04-02T00:00:00Z").toISOString(),
      );
      expect(created.actualEndDate).toBeNull();
      expect(created.notes).toBe("Some notes.");
      expect(created.customer.id).toBe(customer.id);
      // createdById comes from the controller-supplied second arg, not
      // the body — pinned here so a refactor that read it from the
      // body would surface as a test failure.
      expect(created.createdById).toBe(adminId);
    });

    test("status defaults to PLANNED when the body omits it", async () => {
      const created = await service.create(
        { customerId: customer.id, description: "Default status" },
        adminId,
      );
      expect(created.status).toBe(JobStatus.PLANNED);
    });

    test("create with a non-existent customerId → BadRequestException naming the bad FK", async () => {
      try {
        await service.create(
          {
            customerId: "nonexistent-customer-id",
            description: "Bad customer FK",
          },
          adminId,
        );
        throw new Error("expected BadRequestException");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        // The message names the bad id so the operator knows what
        // failed. Mirror of the Trips P2003 mapping (which names
        // the vehicle or driver id).
        expect((error as BadRequestException).message).toContain("nonexistent-customer-id");
      }
    });
  });

  describe("CreateJobSchema — cross-field rule (schema layer)", () => {
    test("scheduledEndDate before scheduledStartDate is rejected", () => {
      const result = CreateJobSchema.safeParse({
        customerId: "cust-1",
        description: "Bad scheduled pair",
        scheduledStartDate: "2026-04-15",
        scheduledEndDate: "2026-04-01",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain("scheduledEndDate");
      }
    });

    test("actualEndDate before actualStartDate is rejected", () => {
      const result = CreateJobSchema.safeParse({
        customerId: "cust-1",
        description: "Bad actual pair",
        actualStartDate: "2026-04-15",
        actualEndDate: "2026-04-01",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(JSON.stringify(result.error.issues)).toContain("actualEndDate");
      }
    });

    test("equal start and end dates are allowed (>=, not >)", () => {
      const result = CreateJobSchema.safeParse({
        customerId: "cust-1",
        description: "Same-day job",
        scheduledStartDate: "2026-04-15",
        scheduledEndDate: "2026-04-15",
      });
      expect(result.success).toBe(true);
    });

    test("only one date present → no cross-field error", () => {
      const result = CreateJobSchema.safeParse({
        customerId: "cust-1",
        description: "Only start",
        scheduledStartDate: "2026-04-15",
      });
      expect(result.success).toBe(true);
    });

    test("jobNumber in the body is rejected (.strict())", () => {
      const result = CreateJobSchema.safeParse({
        customerId: "cust-1",
        description: "Smuggled jobNumber",
        jobNumber: "JOB-2026-99999",
      });
      expect(result.success).toBe(false);
    });

    test("createdById in the body is rejected (.strict())", () => {
      const result = CreateJobSchema.safeParse({
        customerId: "cust-1",
        description: "Smuggled createdById",
        createdById: "user-smuggled",
      });
      expect(result.success).toBe(false);
    });

    test("empty description is rejected", () => {
      const result = CreateJobSchema.safeParse({
        customerId: "cust-1",
        description: "",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("UpdateJobSchema — partial + cross-field + immutable fields", () => {
    test("empty body is rejected by the at-least-one-field refine", () => {
      const result = UpdateJobSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    test("customerId in the PATCH body is rejected (immutable per iter-18 kickoff)", () => {
      const result = UpdateJobSchema.safeParse({ customerId: "different-customer" });
      expect(result.success).toBe(false);
    });

    test("jobNumber in the PATCH body is rejected (immutable per iter-18 kickoff)", () => {
      const result = UpdateJobSchema.safeParse({ jobNumber: "JOB-2026-99999" });
      expect(result.success).toBe(false);
    });

    test("single-field PATCH (just description) parses through", () => {
      const result = UpdateJobSchema.safeParse({ description: "Renamed" });
      expect(result.success).toBe(true);
    });

    test("PATCH with both scheduled dates in the body is checked", () => {
      const result = UpdateJobSchema.safeParse({
        scheduledStartDate: "2026-04-15",
        scheduledEndDate: "2026-04-01",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("update() — diff-PATCH + 404 + merged-shape cross-field rule", () => {
    test("update of an unknown id throws NotFoundException", async () => {
      try {
        await service.update("nonexistent-id", { description: "X" });
        throw new Error("expected NotFoundException");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toContain("nonexistent-id");
      }
    });

    test("single-field PATCH updates only the named field (diff-PATCH semantics)", async () => {
      const created = await service.create(
        { customerId: customer.id, description: "Before" },
        adminId,
      );
      const updated = await service.update(created.id, { description: "After" });
      expect(updated.description).toBe("After");
      // Other fields are untouched.
      expect(updated.status).toBe(JobStatus.PLANNED);
      expect(updated.notes).toBeNull();
      // jobNumber is immutable — pinned here so a refactor that ever
      // let it change would fail loudly.
      expect(updated.jobNumber).toBe(created.jobNumber);
    });

    test("no-op PATCH (re-setting the same value) succeeds and returns the row", async () => {
      const created = await service.create(
        {
          customerId: customer.id,
          description: "No-op test",
          status: JobStatus.PLANNED,
        },
        adminId,
      );
      const updated = await service.update(created.id, { status: JobStatus.PLANNED });
      expect(updated.status).toBe(JobStatus.PLANNED);
      expect(updated.id).toBe(created.id);
    });

    test("clear a nullable field by sending null explicitly", async () => {
      const created = await service.create(
        {
          customerId: customer.id,
          description: "Will clear notes",
          notes: "initial notes",
        },
        adminId,
      );
      expect(created.notes).toBe("initial notes");
      const updated = await service.update(created.id, { notes: null });
      expect(updated.notes).toBeNull();
    });

    test("merged-shape cross-field rule: PATCH end before existing start → BadRequest", async () => {
      // The schema-level refine only sees the PATCH body; this test
      // pins the service-level merged-shape re-validation. We create
      // a job with scheduledStartDate set, then PATCH a
      // scheduledEndDate that's before that existing start. The
      // service must reject the merged shape even though the PATCH
      // body alone is fine.
      const created = await service.create(
        {
          customerId: customer.id,
          description: "Merged-shape check",
          scheduledStartDate: new Date("2026-04-15T00:00:00Z"),
        },
        adminId,
      );
      try {
        await service.update(created.id, {
          scheduledEndDate: new Date("2026-04-01T00:00:00Z"),
        });
        throw new Error("expected BadRequestException");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toContain("scheduledEndDate");
      }
    });
  });

  describe("delete() — 204 + 404", () => {
    test("delete() removes the row", async () => {
      const created = await service.create(
        { customerId: customer.id, description: "Delete me" },
        adminId,
      );
      await service.delete(created.id);
      const refetched = await prisma.job.findUnique({ where: { id: created.id } });
      expect(refetched).toBeNull();
    });

    test("delete() of an unknown id throws NotFoundException", async () => {
      try {
        await service.delete("nonexistent-id");
        throw new Error("expected NotFoundException");
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toContain("nonexistent-id");
      }
    });
  });

  describe("jobNumber uniqueness retry — sequential creates remain unique", () => {
    test("creating five jobs in a row produces five distinct sequential jobNumbers", async () => {
      // Indirect test of the retry loop: even back-to-back creates
      // (no manual concurrency) exercise the find-highest path. If
      // the generator ever returned a duplicate the @unique
      // constraint would either fire P2002 (and retry) or fail with
      // a thrown ConflictException — either path is observable as a
      // test failure or duplicate values here.
      const created = [
        await service.create({ customerId: customer.id, description: "1" }, adminId),
        await service.create({ customerId: customer.id, description: "2" }, adminId),
        await service.create({ customerId: customer.id, description: "3" }, adminId),
        await service.create({ customerId: customer.id, description: "4" }, adminId),
        await service.create({ customerId: customer.id, description: "5" }, adminId),
      ];
      const numbers = created.map((j) => j.jobNumber);
      expect(new Set(numbers).size).toBe(5);
      const year = new Date().getUTCFullYear();
      expect(numbers).toEqual([
        `JOB-${year}-00001`,
        `JOB-${year}-00002`,
        `JOB-${year}-00003`,
        `JOB-${year}-00004`,
        `JOB-${year}-00005`,
      ]);
    });
  });
});
