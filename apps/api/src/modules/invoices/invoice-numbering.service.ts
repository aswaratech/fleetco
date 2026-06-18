import { bsFiscalYear } from "@fleetco/shared";
import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { DocumentType, Prisma } from "@prisma/client";

import { formatInvoiceNumber } from "./invoice-number";

/**
 * Assigns gapless, BS-fiscal-year-scoped, never-reused invoice / credit-note
 * numbers (Program D / ADR-0039 commitment 4). A focused issuing collaborator so
 * the gapless counter is a self-contained, directly-testable unit (the property
 * that distinguishes it from a Postgres SEQUENCE — gapless across ROLLBACKS — is
 * exercised in invoice-numbering.test.ts).
 *
 * The mechanism HARDENS, but does not reuse, JobsService.nextJobNumber: instead
 * of find-highest+1 (which leaves holes on delete and keys by the Gregorian
 * year), it reads a dedicated per-series counter row `SELECT … FOR UPDATE` inside
 * the issuing $transaction and increments it — so two concurrent issues serialize
 * on the row (no holes, no reuse), the series is keyed by the Nepali fiscal year,
 * and the number is assigned ONLY at issue (a discarded DRAFT consumes none).
 */
@Injectable()
export class InvoiceNumberingService {
  /**
   * Return the next number for a document series, advancing the counter inside
   * the caller's interactive `$transaction` (so the advance and the invoice
   * write commit together — the Trip→Vehicle odometer-bump / ADR-0037
   * anchor-advance precedent). MUST be called with a transaction client `tx`;
   * the `FOR UPDATE` lock and the rollback-safety both depend on running inside
   * one transaction.
   *
   * Steps:
   *   1. Derive the BS fiscal year from `issuedAt` (Shrawan→Ashadh, via the
   *      shared bsFiscalYear). An out-of-BS-range date throws (a clear error,
   *      never a fabricated number) — operator/accountant territory (ADR-0039 c9).
   *   2. Ensure the counter row exists — `INSERT … ON CONFLICT DO NOTHING`, so a
   *      concurrent first-issue of the same (series, fy) cannot double-insert.
   *   3. `SELECT "lastValue" … FOR UPDATE` — locks the row; a concurrent issue of
   *      the same series/fy blocks here until this transaction COMMITS, which is
   *      what makes the sequence gapless and reuse-free under contention.
   *   4. `UPDATE … SET "lastValue" = next` — the increment commits with the
   *      transaction; a ROLLBACK reverts it, so a failed issue never burns a
   *      number (the deliberate contrast with a SEQUENCE, which advances on
   *      rollback).
   */
  async nextNumber(
    tx: Prisma.TransactionClient,
    documentType: DocumentType,
    issuedAt: Date,
  ): Promise<string> {
    const fy = bsFiscalYear(issuedAt.toISOString());
    if (fy === null) {
      throw new UnprocessableEntityException(
        `Cannot derive a Bikram Sambat fiscal year for issue date ${issuedAt.toISOString()}: ` +
          "it falls outside the supported BS calendar range. An out-of-range date needs " +
          "operator/accountant verification before issue (ADR-0039 c9).",
      );
    }

    // 1. Ensure the counter row exists (idempotent, race-safe). documentType is
    //    cast to its Postgres enum type; every value is bound as a parameter, so
    //    there is no SQL-injection surface (the telematics $queryRaw precedent).
    await tx.$executeRaw`
      INSERT INTO "invoice_number_sequence" ("documentType", "bsFiscalYear", "lastValue")
      VALUES (${documentType}::"document_type", ${fy.label}, 0)
      ON CONFLICT ("documentType", "bsFiscalYear") DO NOTHING`;

    // 2. Lock the row and read the current value. FOR UPDATE serializes
    //    concurrent issues of this (series, fy) on this one row.
    const rows = await tx.$queryRaw<{ lastValue: number }[]>`
      SELECT "lastValue" FROM "invoice_number_sequence"
      WHERE "documentType" = ${documentType}::"document_type" AND "bsFiscalYear" = ${fy.label}
      FOR UPDATE`;
    const row = rows[0];
    if (row === undefined) {
      // Unreachable: step 1 guarantees the row exists. Fail loudly rather than
      // silently start a parallel sequence at 1 (which would create a gap/dupe).
      throw new Error(
        `Invoice number counter row missing after upsert for ${documentType} ${fy.label}.`,
      );
    }
    const next = row.lastValue + 1;

    // 3. Persist the increment. Safe to read-then-write: the FOR UPDATE lock is
    //    held until this transaction ends, so no other issue can read this row in
    //    between. The advance is visible to others only after COMMIT.
    await tx.$executeRaw`
      UPDATE "invoice_number_sequence" SET "lastValue" = ${next}
      WHERE "documentType" = ${documentType}::"document_type" AND "bsFiscalYear" = ${fy.label}`;

    return formatInvoiceNumber(documentType, fy.label, next);
  }
}
