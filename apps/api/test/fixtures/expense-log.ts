import { type ExpenseLog, ExpenseCategory, type PrismaClient } from "@prisma/client";

// Test fixtures for the Expense-logs slice. ExpenseLog's FKs are
// `vehicleId` (nullable), `tripId` (nullable), and `createdById`
// (required). Unlike Fuel logs, neither parent FK is required — the
// "vehicle-agnostic expense" case (the quarterly insurance premium,
// office stationery) is a legitimate row with both vehicleId and
// tripId null. Tests that exercise the per-vehicle filter still
// require a Vehicle row to point at; the `seedVehicle` / `seedTrip`
// / `seedDriver` / `seedUser` helpers from trip.ts cover the parent
// rows. This file adds only the ExpenseLog-specific helper.
//
// Kept under apps/api/test/fixtures/ — same convention every other
// slice's fixtures use. Promoting these helpers to a shared package
// is deferred until a second test consumer needs them (the iter-22
// write-path tests are the obvious next consumer; they can import
// from here directly without a package boundary).

/**
 * Create an ExpenseLog row with sensible defaults. The caller must
 * supply `createdById` (the User FK is required); `vehicleId` and
 * `tripId` are optional and default to null so the helper's default
 * case is a vehicle-agnostic expense — matching the canonical
 * "office stationery" / "insurance premium" examples from the model
 * docstring and the iter-21 glossary entry.
 *
 * Defaults reflect a routine MAINTENANCE expense:
 *
 *   - date     = 2026-02-15 (mid-range for the test month windows)
 *   - category = MAINTENANCE
 *   - amountPaisa = 250_000 (NPR 2,500 — a plausible tyre-rotation
 *     bill the operator would log)
 *   - vendor / receiptNumber / notes = null
 *
 * The defaults are explicit so that a test asserting the default
 * row's shape (e.g., "the empty filter list returns the seeded
 * date") can rely on stable values across reseeds. Override any
 * field via the `overrides` parameter when a specific test needs
 * particular values (e.g., a different category, a specific
 * vehicleId, a different month for date-range filter tests).
 */
export interface SeedExpenseLogParams {
  createdById: string;
  vehicleId?: string | null;
  tripId?: string | null;
  date?: Date;
  category?: ExpenseCategory;
  amountPaisa?: number;
  vendor?: string | null;
  receiptNumber?: string | null;
  notes?: string | null;
}

export async function seedExpenseLog(
  prisma: PrismaClient,
  params: SeedExpenseLogParams,
): Promise<ExpenseLog> {
  return prisma.expenseLog.create({
    data: {
      createdById: params.createdById,
      vehicleId: params.vehicleId === undefined ? null : params.vehicleId,
      tripId: params.tripId === undefined ? null : params.tripId,
      date: params.date ?? new Date("2026-02-15T08:00:00Z"),
      category: params.category ?? ExpenseCategory.MAINTENANCE,
      amountPaisa: params.amountPaisa ?? 250_000,
      vendor: params.vendor === undefined ? null : params.vendor,
      receiptNumber: params.receiptNumber === undefined ? null : params.receiptNumber,
      notes: params.notes === undefined ? null : params.notes,
    },
  });
}
