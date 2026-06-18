import { UnprocessableEntityException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { formatInvoiceNumber } from "../src/modules/invoices/invoice-number";
import { InvoiceNumberingService } from "../src/modules/invoices/invoice-numbering.service";
import { PrismaService } from "../src/modules/prisma/prisma.service";
import { resetDb } from "./db";

// Tests for the gapless invoice-number counter (Program D / ADR-0039 c4). Two
// layers:
//   1. The pure formatter (formatInvoiceNumber) — prefix + zero-pad, no DB.
//   2. The InvoiceNumberingService against real Postgres — the load-bearing
//      properties: gapless within a (series, fiscal year); concurrent issues
//      serialize on the SELECT … FOR UPDATE'd counter row (no dupes/holes); a
//      rolled-back issue does NOT burn a number (the deliberate contrast with a
//      Postgres SEQUENCE); independent series per fiscal year and per
//      documentType (INVOICE vs CREDIT_NOTE).
//
// Fiscal-year dates below are verified against nepali-date-converter@3.4.0:
//   2025-08-01 → BS 2082 Shrawan → FY 2082-83
//   2026-08-01 → BS 2083 Shrawan → FY 2083-84
const FY_2082_83 = new Date("2025-08-01T00:00:00.000Z");
const FY_2083_84 = new Date("2026-08-01T00:00:00.000Z");
// The EXACT adjacent-day fiscal-year boundary (the same pair invoice-fiscal-year.ts
// pins for the pure derivation): 2025-07-16 → BS 2082 Ashadh 32, the LAST day of FY
// 2081-82; 2025-07-17 → BS 2082 Shrawan 1, the FIRST day of FY 2082-83.
const ASHADH_END_FY_2081_82 = new Date("2025-07-16T00:00:00.000Z");
const SHRAWAN_1_FY_2082_83 = new Date("2025-07-17T00:00:00.000Z");

describe("formatInvoiceNumber (pure)", () => {
  test("INVOICE → INV prefix, 5-digit zero-padded sequence", () => {
    expect(formatInvoiceNumber("INVOICE", "2082-83", 1)).toBe("INV-2082-83-00001");
    expect(formatInvoiceNumber("INVOICE", "2082-83", 42)).toBe("INV-2082-83-00042");
  });

  test("CREDIT_NOTE → CRN prefix (an independent, visibly-distinct series)", () => {
    expect(formatInvoiceNumber("CREDIT_NOTE", "2082-83", 1)).toBe("CRN-2082-83-00001");
  });

  test("a sequence past 99,999 widens rather than truncating (degrade, not data loss)", () => {
    expect(formatInvoiceNumber("INVOICE", "2082-83", 100_000)).toBe("INV-2082-83-100000");
  });
});

describe("InvoiceNumberingService (integration, real Postgres)", () => {
  let module: TestingModule;
  let prisma: PrismaService;
  let numbering: InvoiceNumberingService;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [InvoiceNumberingService, PrismaService],
    }).compile();
    await module.init();
    prisma = module.get(PrismaService);
    numbering = module.get(InvoiceNumberingService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
  });

  // Run nextNumber inside a committed transaction — the production call shape.
  async function issueOne(
    documentType: "INVOICE" | "CREDIT_NOTE",
    issuedAt: Date,
  ): Promise<string> {
    return prisma.$transaction((tx) => numbering.nextNumber(tx, documentType, issuedAt));
  }

  test("hands out gapless consecutive numbers within a (series, fiscal year)", async () => {
    const numbers: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      numbers.push(await issueOne("INVOICE", FY_2082_83));
    }
    expect(numbers).toEqual([
      "INV-2082-83-00001",
      "INV-2082-83-00002",
      "INV-2082-83-00003",
      "INV-2082-83-00004",
      "INV-2082-83-00005",
    ]);
  });

  test("concurrent issues serialize on the counter → no dupes, no holes", async () => {
    // Five issues fired at once. The SELECT … FOR UPDATE makes each wait for the
    // previous to commit, so the outcome is exactly {00001..00005} regardless of
    // completion order — the property that prevents two invoices sharing a number.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => issueOne("INVOICE", FY_2082_83)),
    );
    expect([...results].sort()).toEqual([
      "INV-2082-83-00001",
      "INV-2082-83-00002",
      "INV-2082-83-00003",
      "INV-2082-83-00004",
      "INV-2082-83-00005",
    ]);
    expect(new Set(results).size).toBe(5); // no duplicate number was handed out
  });

  test("a rolled-back issue does NOT burn a number (the deliberate SEQUENCE contrast)", async () => {
    const n1 = await issueOne("INVOICE", FY_2082_83);
    expect(n1).toBe("INV-2082-83-00001");

    // A transaction that takes a number, then throws → the whole transaction
    // rolls back, so the counter increment is reverted.
    let burned: string | undefined;
    await expect(
      prisma.$transaction(async (tx) => {
        burned = await numbering.nextNumber(tx, "INVOICE", FY_2082_83);
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(burned).toBe("INV-2082-83-00002"); // it WOULD have been 00002…

    // …but the next committed issue REUSES 00002 — no gap. A Postgres SEQUENCE
    // would have advanced past it, giving 00003 and a permanent hole.
    const n2 = await issueOne("INVOICE", FY_2082_83);
    expect(n2).toBe("INV-2082-83-00002");

    // The counter reflects exactly the two COMMITTED issues.
    const counter = await prisma.invoiceNumberSequence.findUnique({
      where: { documentType_bsFiscalYear: { documentType: "INVOICE", bsFiscalYear: "2082-83" } },
    });
    expect(counter?.lastValue).toBe(2);
  });

  test("each Bikram Sambat fiscal year gets its own …-00001 series", async () => {
    expect(await issueOne("INVOICE", FY_2082_83)).toBe("INV-2082-83-00001");
    expect(await issueOne("INVOICE", FY_2082_83)).toBe("INV-2082-83-00002");
    // A new fiscal year starts a fresh sequence at 00001, independent of 2082-83.
    expect(await issueOne("INVOICE", FY_2083_84)).toBe("INV-2083-84-00001");
    // …and the prior fiscal year resumes where it left off.
    expect(await issueOne("INVOICE", FY_2082_83)).toBe("INV-2082-83-00003");
  });

  test("the series rolls to a fresh …-00001 across the EXACT Shrawan-1 boundary", async () => {
    // Two issues ONE calendar day apart but in DIFFERENT fiscal years: the last day
    // of FY 2081-82 (Ashadh 32) and the first day of FY 2082-83 (Shrawan 1). The
    // counter keys off the BS FISCAL year, not the calendar day, so the second starts
    // a fresh series — the boundary the year-apart test above does not pin (it uses
    // dates a full year apart). This is the gapless-numbering compliance property at
    // the one instant it is most fragile.
    expect(await issueOne("INVOICE", ASHADH_END_FY_2081_82)).toBe("INV-2081-82-00001");
    expect(await issueOne("INVOICE", SHRAWAN_1_FY_2082_83)).toBe("INV-2082-83-00001");
    // The just-closed fiscal year resumes its own series independently — a
    // late-arriving Ashadh-dated issue does NOT collide with the new year's 00001.
    expect(await issueOne("INVOICE", ASHADH_END_FY_2081_82)).toBe("INV-2081-82-00002");
  });

  test("INVOICE and CREDIT_NOTE keep independent series for the same fiscal year", async () => {
    expect(await issueOne("INVOICE", FY_2082_83)).toBe("INV-2082-83-00001");
    expect(await issueOne("INVOICE", FY_2082_83)).toBe("INV-2082-83-00002");
    // The credit-note series is its own gapless sequence (ADR-0039 c5).
    expect(await issueOne("CREDIT_NOTE", FY_2082_83)).toBe("CRN-2082-83-00001");
    expect(await issueOne("INVOICE", FY_2082_83)).toBe("INV-2082-83-00003");
    expect(await issueOne("CREDIT_NOTE", FY_2082_83)).toBe("CRN-2082-83-00002");
  });

  test("an out-of-BS-range issue date throws (a clear error, never a fabricated number)", async () => {
    // 2050 is past the converter's BS table (it ends ~AD 2034 / BS 2090), so the
    // fiscal year cannot be derived; the service refuses rather than guessing.
    await expect(
      prisma.$transaction((tx) =>
        numbering.nextNumber(tx, "INVOICE", new Date("2050-01-01T00:00:00.000Z")),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // …and nothing was written — no counter row for any fiscal year.
    expect(await prisma.invoiceNumberSequence.count()).toBe(0);
  });
});
