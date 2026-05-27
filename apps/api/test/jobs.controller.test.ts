import { randomUUID } from "node:crypto";
import { BadRequestException, NotFoundException, type INestApplication } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { JobStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { AuthGuard } from "../src/modules/auth/auth.guard";
import { AUTH } from "../src/modules/auth/auth.tokens";
import { JobsController } from "../src/modules/jobs/jobs.controller";
import { ListJobsQuerySchema } from "../src/modules/jobs/jobs.schemas";
import { JobsService } from "../src/modules/jobs/jobs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for JobsController, mirror of the iter-15
// CustomersController and iter-8 TripsController test files.
//
// Two-layer structure:
//   1. Schema/pipe layer: ZodValidationPipe applied to
//      ListJobsQuerySchema. Whether a bogus query key surfaces as
//      HTTP 400 is a property of the schema's .strict() flag plus
//      the pipe's translation to BadRequestException — exercised
//      directly without booting an HTTP server.
//
//   2. Controller layer: JobsController.list() / getById() called
//      against a real PrismaService + real JobsService, with
//      AuthGuard overridden to pass-through. The response shape
//      { items, total, skip, take, sortBy, sortDir } is asserted
//      here per the iter-17 ticket spec.
//
// Auth-gate (real 401 without cookie) is intentionally NOT exercised
// here — auth.guard.test.ts already pins that path at the guard
// level. Mirror of every other controller test in this codebase.

describe("JobsController list-query schema (iter-17 contract)", () => {
  // Pipe-level tests do not need a TestingModule — the pipe and
  // schema are pure code and can be tested directly. This is the
  // cheapest way to assert "bogus query key → 400" without booting
  // Nest. Same shape as the Customers / Drivers / Trips pipe blocks.
  const pipe = new ZodValidationPipe(ListJobsQuerySchema);

  test("bogus query key (e.g. ?staus=PLANNED) → BadRequestException (HTTP 400)", () => {
    // The schema is .strict(), so an unknown key fails parse(). The
    // pipe translates ZodError to BadRequestException. The runbook's
    // api-error-mapping table is the spec being verified here.
    expect(() => pipe.transform({ staus: "PLANNED" })).toThrow(BadRequestException);
  });

  test("invalid status enum value → BadRequestException", () => {
    // The csvEnum transform rejects unknown enum members with a 400.
    // JobStatus has PLANNED / IN_PROGRESS / COMPLETED / CANCELLED;
    // any other value fails.
    expect(() => pipe.transform({ status: "DRAFT" })).toThrow(BadRequestException);
  });

  test("invalid sortBy column (off-whitelist) → BadRequestException", () => {
    // The whitelist is createdAt / jobNumber / scheduledStartDate.
    // Any other column (including legitimate-looking `description`
    // or `notes`) returns 400. This is both a schema check and an
    // information-disclosure defense — refusing to sort by free-form
    // text columns prevents leaking ordering information about
    // operator-typed text, mirroring the defense Trips applies to
    // `notes` and Customers applies to `panNumber`.
    expect(() => pipe.transform({ sortBy: "description" })).toThrow(BadRequestException);
  });

  test("sortBy=notes is rejected (information-disclosure defense)", () => {
    // Pinned so a refactor that "helpfully" widens the whitelist to
    // all columns would fail loudly. Free-form notes content must
    // not be sortable. Same defense the Trips schema applies to
    // `notes` directly.
    expect(() => pipe.transform({ sortBy: "notes" })).toThrow(BadRequestException);
  });

  test("sortBy=createdById is rejected (information-disclosure defense)", () => {
    // Even an internal admin-only field that exists on the row is
    // off-whitelist. Mirror of the Customers test that pins the
    // same defense.
    expect(() => pipe.transform({ sortBy: "createdById" })).toThrow(BadRequestException);
  });

  test("take above the 200 ceiling → BadRequestException with field-named message", () => {
    // The schema mirrors the service's MAX_TAKE clamp at 200 and
    // rejects above it. The error message names the field so the
    // client can surface it inline.
    try {
      pipe.transform({ take: "999" });
      throw new Error("expected BadRequestException");
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const message = (error as BadRequestException).message;
      expect(message.toLowerCase()).toContain("take");
    }
  });

  test("skip below zero → BadRequestException", () => {
    expect(() => pipe.transform({ skip: "-1" })).toThrow(BadRequestException);
  });

  test("non-integer take → BadRequestException", () => {
    expect(() => pipe.transform({ take: "abc" })).toThrow(BadRequestException);
  });

  test("valid query passes through with parsed types (string → number, csv → array)", () => {
    // The transforms in jobs.schemas.ts turn URL-shaped strings into
    // typed values: `skip=10` becomes the number 10;
    // `status=PLANNED,IN_PROGRESS` becomes the array
    // [PLANNED, IN_PROGRESS]. Pinning this conversion catches a
    // regression that would forward strings to the service layer.
    const result = pipe.transform({
      status: "PLANNED,IN_PROGRESS",
      customerId: "cust_abc",
      sortBy: "jobNumber",
      sortDir: "asc",
      skip: "10",
      take: "50",
    });
    expect(result.status).toEqual([JobStatus.PLANNED, JobStatus.IN_PROGRESS]);
    expect(result.customerId).toBe("cust_abc");
    expect(result.sortBy).toBe("jobNumber");
    expect(result.sortDir).toBe("asc");
    expect(result.skip).toBe(10);
    expect(result.take).toBe(50);
  });

  test("empty query → undefined fields (defaults applied at controller/service)", () => {
    // No filter/sort/paginate params should produce an all-undefined
    // shape so the controller can apply its defaults. The schema
    // must NOT eagerly default these — that's the controller's job
    // — because letting the schema default them would make it
    // impossible to distinguish "client didn't ask" from "client
    // asked for the default". Mirror of the Customers test.
    const result = pipe.transform({});
    expect(result.status).toBeUndefined();
    expect(result.customerId).toBeUndefined();
    expect(result.sortBy).toBeUndefined();
    expect(result.sortDir).toBeUndefined();
    expect(result.skip).toBeUndefined();
    expect(result.take).toBeUndefined();
  });

  test("status=PLANNED (single value, no comma) parses to a one-element array", () => {
    // The csvEnum transform handles both single and comma-separated
    // inputs uniformly. A bare `?status=PLANNED` should produce
    // [PLANNED], not "PLANNED" (which the service would not know
    // how to feed into Prisma's `in:` filter).
    const result = pipe.transform({ status: "PLANNED" });
    expect(result.status).toEqual([JobStatus.PLANNED]);
  });
});

describe("JobsController.list (integration, real Prisma)", () => {
  // Full controller-level integration: a real JobsController with a
  // real JobsService and a real PrismaService, with AuthGuard
  // overridden to pass-through. The kickoff calls for the response
  // shape { items, total, skip, take, sortBy, sortDir } to be
  // asserted here.

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: JobsController;
  let adminId: string;
  let customerId: string;
  let jobSeq = 0;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        JobsService,
        PrismaService,
        // AUTH is required by AuthGuard's constructor. The override
        // below replaces the guard itself, but Nest still resolves
        // its dependencies — provide a benign stub so DI does not
        // fail on AUTH lookup. Same shape as the Customers /
        // Trips controller integration blocks.
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(JobsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
    const customer = await prisma.customer.create({
      data: {
        name: `Acme Construction ${randomUUID().slice(0, 6)}`,
        phone: "+977-9800000000",
        createdById: adminId,
      },
    });
    customerId = customer.id;
    jobSeq = 0;
  });

  async function seedJob(
    overrides: {
      jobNumber?: string;
      status?: JobStatus;
      customerId?: string;
    } = {},
  ) {
    jobSeq += 1;
    return prisma.job.create({
      data: {
        // Auto-incrementing JOB-2026-NNNNN so tests can seed many
        // rows without colliding on the @unique jobNumber index.
        // Production generation lands in iter 18.
        jobNumber: overrides.jobNumber ?? `JOB-2026-${String(jobSeq).padStart(5, "0")}`,
        customerId: overrides.customerId ?? customerId,
        description: "Test job",
        status: overrides.status ?? JobStatus.PLANNED,
        createdById: adminId,
      },
    });
  }

  test("valid filter+sort+page returns response shape { items, total, skip, take, sortBy, sortDir }", async () => {
    // Seed two jobs so total > 0 and the response has visible
    // structure. Mirror of the Customers / Trips contract test.
    await seedJob({ status: JobStatus.PLANNED });
    await seedJob({ status: JobStatus.IN_PROGRESS });

    const response = await controller.list({
      status: [JobStatus.PLANNED],
      sortBy: "jobNumber",
      sortDir: "asc",
      skip: 0,
      take: 10,
    });

    expect(response).toMatchObject({
      total: 1,
      skip: 0,
      take: 10,
      sortBy: "jobNumber",
      sortDir: "asc",
    });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.status).toBe(JobStatus.PLANNED);
  });

  test("empty query → controller applies defaults (sortBy=createdAt, sortDir=desc, skip=0, take=LIST_TAKE_DEFAULT)", async () => {
    await seedJob();

    const response = await controller.list({});

    // LIST_TAKE_DEFAULT is 20 per jobs.service.ts; pinned here so a
    // change to that constant surfaces in the test as well as in
    // the contract. Mirror of the Customers / Trips list-defaults
    // tests.
    expect(response.skip).toBe(0);
    expect(response.take).toBe(20);
    expect(response.sortBy).toBe("createdAt");
    expect(response.sortDir).toBe("desc");
    expect(response.total).toBe(1);
  });

  test("response.items and response.total agree when no pagination is applied", async () => {
    // Sanity: total should equal items.length when the page contains
    // the whole result set. This protects against a regression in
    // the service's $transaction([findMany, count]) where the WHERE
    // clause differs between the two calls. Mirror of the Customers
    // sanity check.
    await seedJob();
    await seedJob();
    await seedJob();

    const response = await controller.list({});
    expect(response.total).toBe(3);
    expect(response.items).toHaveLength(3);
  });

  test("customerId filter restricts results to that customer's jobs", async () => {
    // The customerId filter is the read path's most common UI driver
    // (the /jobs list URL is typically deep-linked from a Customer
    // detail page with ?customerId=cust_X). Pinning the wire shape
    // here so the web client can rely on it.
    const otherCustomer = await prisma.customer.create({
      data: {
        name: `Other Customer ${randomUUID().slice(0, 6)}`,
        phone: "+977-9811111111",
        createdById: adminId,
      },
    });

    await seedJob();
    await seedJob();
    await seedJob({ customerId: otherCustomer.id });

    const response = await controller.list({ customerId: otherCustomer.id });
    expect(response.total).toBe(1);
    expect(response.items).toHaveLength(1);
    expect(response.items[0]?.customerId).toBe(otherCustomer.id);
  });

  test("list items carry the nested customer { id, name } projection", async () => {
    // The slim LIST_SELECT projection includes a nested
    // customer: { select: { id, name } } so the list page can
    // render "Customer: Acme Construction" without a per-row
    // round-trip. Pinning the shape here so a refactor that
    // narrowed or widened the projection would surface as a
    // controller-test failure as well as a service-test failure.
    await seedJob();

    const response = await controller.list({});
    expect(response.items[0]?.customer).toBeDefined();
    expect(response.items[0]?.customer.id).toBe(customerId);
    expect(response.items[0]?.customer.name).toMatch(/^Acme Construction/);
  });
});

describe("JobsController.getById (integration, real Prisma)", () => {
  // Detail-route integration: existence check + 404 mapping. Mirror
  // of the iter-15 Customers detail tests.

  let module: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let controller: JobsController;
  let adminId: string;
  let customerId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        JobsService,
        PrismaService,
        { provide: AUTH, useValue: { api: { getSession: () => null } } },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = module.createNestApplication();
    await app.init();

    prisma = module.get(PrismaService);
    controller = module.get(JobsController);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    adminId = `user_${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: adminId,
        email: `admin-${adminId}@fleetco.test`,
        name: "Test Admin",
      },
    });
    const customer = await prisma.customer.create({
      data: {
        name: "Acme Construction Pvt. Ltd.",
        phone: "+977-9800000000",
        createdById: adminId,
      },
    });
    customerId = customer.id;
  });

  test("returns the job with the full nested customer when present", async () => {
    // The DETAIL_INCLUDE shape includes `customer: true` (the full
    // customer record, not the slim list projection), so the detail
    // page can render every customer field and deep-link back to
    // /customers/<id>. Pinning the shape here so a refactor that
    // narrowed DETAIL_INCLUDE to a select would fail the
    // controller-level contract.
    const created = await prisma.job.create({
      data: {
        jobNumber: "JOB-2026-00001",
        customerId,
        description: "Foundation pour at Block A",
        status: JobStatus.PLANNED,
        notes: "Operator notes here",
        createdById: adminId,
      },
    });

    const fetched = await controller.getById(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.jobNumber).toBe("JOB-2026-00001");
    expect(fetched.description).toBe("Foundation pour at Block A");
    expect(fetched.status).toBe(JobStatus.PLANNED);
    expect(fetched.customer.id).toBe(customerId);
    expect(fetched.customer.name).toBe("Acme Construction Pvt. Ltd.");
    // Full customer record on detail → phone is present (it's not
    // present in the slim list projection). Pinning the distinction.
    expect(fetched.customer.phone).toBe("+977-9800000000");
  });

  test("unknown id → NotFoundException (HTTP 404) with the id named in the message", async () => {
    // The service.getById throws NotFoundException with the id in
    // the message; the controller is declarative — it just
    // delegates. The runbook commits to "Job {id} not found"
    // wording; we assert the id appears so a future message
    // refactor that dropped it would fail.
    try {
      await controller.getById("nonexistent-job-id");
      throw new Error("expected NotFoundException");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toContain("nonexistent-job-id");
    }
  });
});
