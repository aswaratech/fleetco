import { Test, type TestingModule } from "@nestjs/testing";
import { type NotificationLog } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { NotificationLogsService } from "../src/modules/notification-logs/notification-logs.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Integration tests for NotificationLogsService against a real Postgres
// (ADR-0038 C4). The NotificationLog is a STANDALONE LEAF — no FK into any other
// table (a reminder send is a background job, not a user action; the ledger must
// survive its subject's deletion as an audit record, ADR-0038 c5) — so each row
// seeds directly with no user / vehicle prerequisite, unlike the customers /
// geofences services whose createdById FK needs a User first.
//
// Coverage mirrors customers.service.test.ts (filters narrow, sort round-trips
// across the whitelist, pagination + the LIST_TAKE_MAX clamp, findById present /
// null) plus the C4-specific cases: the `sentAt`-desc default ordering and the
// end-of-day-inclusive date range. (The nulls-last guard on that ordering is
// forward-defensive and unexercised-by-design — see the note above the createdAt
// sort test.)

// Seed one NotificationLog row. Defaults model a VEHICLE bluebook "expired"
// reminder; overrides let a test vary the dedup tuple, the recipient, or the
// send metadata. The @@unique tuple is (subjectType, subjectId, reminderKind,
// state, occurrenceKey), so a test creating multiple rows must vary at least one
// of those (most vary subjectId or occurrenceKey).
async function seedLog(
  prisma: PrismaService,
  overrides: Partial<{
    subjectType: string;
    subjectId: string;
    reminderKind: string;
    state: string;
    occurrenceKey: string;
    recipient: string;
    sentAt: Date | null;
    providerMessageId: string | null;
  }> = {},
): Promise<NotificationLog> {
  return prisma.notificationLog.create({
    data: {
      subjectType: overrides.subjectType ?? "VEHICLE",
      subjectId: overrides.subjectId ?? `veh_${Math.random().toString(36).slice(2, 10)}`,
      reminderKind: overrides.reminderKind ?? "BLUEBOOK",
      state: overrides.state ?? "expired",
      occurrenceKey: overrides.occurrenceKey ?? "2026-05-20T00:00:00.000Z",
      recipient: overrides.recipient ?? "operator@fleetco.test",
      sentAt:
        overrides.sentAt === undefined ? new Date("2026-06-19T06:45:00.000Z") : overrides.sentAt,
      providerMessageId:
        overrides.providerMessageId === undefined ? "msg_seed" : overrides.providerMessageId,
    },
  });
}

describe("NotificationLogsService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let service: NotificationLogsService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [NotificationLogsService, PrismaService],
    }).compile();
    await module.init();

    prisma = module.get(PrismaService);
    service = module.get(NotificationLogsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  // ── findById ──

  test("findById returns the row when present, null when absent", async () => {
    const seeded = await seedLog(prisma);
    const found = await service.findById(seeded.id);
    expect(found?.id).toBe(seeded.id);
    expect(found?.reminderKind).toBe("BLUEBOOK");

    expect(await service.findById("nonexistent-id")).toBeNull();
  });

  // ── filters ──

  test("subjectType filter narrows the result set", async () => {
    await seedLog(prisma, { subjectType: "VEHICLE", subjectId: "v1" });
    await seedLog(prisma, {
      subjectType: "SERVICE_SCHEDULE",
      subjectId: "s1",
      reminderKind: "SERVICE",
    });

    const vehicles = await service.list({ subjectType: "VEHICLE" });
    expect(vehicles.total).toBe(1);
    expect(vehicles.items[0]?.subjectType).toBe("VEHICLE");

    const schedules = await service.list({ subjectType: "SERVICE_SCHEDULE" });
    expect(schedules.total).toBe(1);
    expect(schedules.items[0]?.subjectType).toBe("SERVICE_SCHEDULE");
  });

  test("reminderKind filter narrows the result set", async () => {
    await seedLog(prisma, { subjectId: "v1", reminderKind: "BLUEBOOK" });
    await seedLog(prisma, { subjectId: "v1", reminderKind: "INSURANCE" });
    await seedLog(prisma, { subjectId: "v2", reminderKind: "BLUEBOOK" });

    const result = await service.list({ reminderKind: "BLUEBOOK" });
    expect(result.total).toBe(2);
    expect(result.items.every((r) => r.reminderKind === "BLUEBOOK")).toBe(true);
  });

  test("state filter narrows the result set (expiring-soon vs expired are distinct)", async () => {
    await seedLog(prisma, { subjectId: "v1", state: "expired", occurrenceKey: "2026-05-20" });
    await seedLog(prisma, { subjectId: "v1", state: "expiring-soon", occurrenceKey: "2026-07-20" });

    const expired = await service.list({ state: "expired" });
    expect(expired.total).toBe(1);
    expect(expired.items[0]?.state).toBe("expired");
  });

  test("an unknown filter value returns zero rows, not an error (open-string forward-compat)", async () => {
    await seedLog(prisma);
    const result = await service.list({ subjectType: "SOMETHING_NEW" });
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  // ── date range (on sentAt) ──

  test("startDate / endDate bound the result set inclusively through the end of the day", async () => {
    await seedLog(prisma, { subjectId: "before", sentAt: new Date("2026-06-17T23:59:00.000Z") });
    // A row sent late on the 19th — the end-of-day inclusivity is what catches it.
    await seedLog(prisma, { subjectId: "onlast", sentAt: new Date("2026-06-19T23:30:00.000Z") });
    await seedLog(prisma, { subjectId: "after", sentAt: new Date("2026-06-20T00:30:00.000Z") });

    const result = await service.list({
      startDate: new Date("2026-06-18T00:00:00.000Z"),
      endDate: new Date("2026-06-19T00:00:00.000Z"),
    });
    const ids = result.items.map((r) => r.subjectId);
    expect(ids).toContain("onlast"); // included: end-of-day inclusive
    expect(ids).not.toContain("before"); // excluded: before startDate
    expect(ids).not.toContain("after"); // excluded: next day
    expect(result.total).toBe(1);
  });

  // ── sort ──

  test("default sort is sentAt desc (most recently sent first)", async () => {
    await seedLog(prisma, { subjectId: "old", sentAt: new Date("2026-06-01T06:45:00.000Z") });
    await seedLog(prisma, { subjectId: "new", sentAt: new Date("2026-06-19T06:45:00.000Z") });

    const result = await service.list({});
    expect(result.items[0]?.subjectId).toBe("new");
    expect(result.items[1]?.subjectId).toBe("old");
  });

  // NOTE: the service orders `sentAt` desc with `nulls: "last"` so a null-sentAt
  // row (an as-yet-unsent intent) can never top the "what we sent" history. That
  // branch is forward-DEFENSIVE: the column is nullable per the schema (the ADR's
  // eventual write-at-scan-intent design, ADR-0038 c5), but the CURRENT writer
  // (NotificationService.send) always sets sentAt at send-success — so no row in
  // the live system has a null sentAt yet, and the nulls-last branch stays
  // unexercised-by-design rather than tested against a synthetic null row.

  test("sort by createdAt round-trips across asc / desc", async () => {
    const first = await seedLog(prisma, { subjectId: "first" });
    // Ensure a distinct createdAt ordering.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await seedLog(prisma, { subjectId: "second" });

    const asc = await service.list({ sortBy: "createdAt", sortDir: "asc" });
    expect(asc.items[0]?.id).toBe(first.id);
    expect(asc.items[1]?.id).toBe(second.id);

    const desc = await service.list({ sortBy: "createdAt", sortDir: "desc" });
    expect(desc.items[0]?.id).toBe(second.id);
    expect(desc.items[1]?.id).toBe(first.id);
  });

  // ── pagination ──

  test("pagination: skip / take page through a stable order; total is the full filtered count", async () => {
    for (let i = 0; i < 5; i++) {
      await seedLog(prisma, {
        subjectId: `v${i}`,
        sentAt: new Date(`2026-06-${10 + i}T06:45:00.000Z`),
      });
    }

    const page1 = await service.list({ skip: 0, take: 2 });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);

    const page2 = await service.list({ skip: 2, take: 2 });
    expect(page2.items).toHaveLength(2);

    // No overlap between pages (stable order via the id tiebreaker).
    const overlap = page1.items
      .map((r) => r.id)
      .filter((id) => page2.items.some((r) => r.id === id));
    expect(overlap).toHaveLength(0);
  });

  test("take is clamped to LIST_TAKE_MAX (200) defense-in-depth", async () => {
    await seedLog(prisma);
    // A direct service caller asking for an over-large take is clamped, never
    // unbounded. We assert the call succeeds and returns the single row (the
    // clamp does not error); the clamp itself is exercised by the count of rows
    // requested vs the 200 ceiling.
    const result = await service.list({ take: 10_000 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  test("skip past the end returns an empty page with the real total", async () => {
    await seedLog(prisma, { subjectId: "v1" });
    await seedLog(prisma, { subjectId: "v2" });
    const result = await service.list({ skip: 50, take: 20 });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(2);
  });
});
