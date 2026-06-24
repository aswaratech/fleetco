import type { Vehicle } from "../vehicles/types";

// Web-side view of the API's ExpenseLog rows. Mirrors the Prisma model
// in apps/api/prisma/schema.prisma (model ExpenseLog) and the API's
// LIST_SELECT / DETAIL_INCLUDE shapes
// (apps/api/src/modules/expense-logs/expense-logs.service.ts).
//
// Dates arrive as ISO strings over the JSON wire, so they are typed as
// `string` here rather than `Date` — same convention as the other web
// types. Money (paisa) stays an integer per CLAUDE.md §"Money & units";
// formatting happens at render time via lib/money.
//
// `vehicle` is NULLABLE on both the list and the detail projections —
// the iter-21 schema admits a vehicle-agnostic expense (e.g., the
// company's quarterly insurance premium) and the list/detail UI render
// the vehicle column as an em-dash when null. `trip` is also nullable
// (an Expense may or may not be paired with a specific trip), matching
// the Fuel logs nullable-trip projection.
//
// Promoting to a shared @fleetco/shared package is deferred until a
// second app (driver app, Phase 2) needs the types. iter 21 is read-
// only; the iter-22 write path adds CreateExpenseLogFormSchema /
// UpdateExpenseLogFormSchema in apps/web/src/lib/expense-logs-schema.ts.

export type ExpenseCategory =
  | "MAINTENANCE"
  | "REPAIR"
  | "TOLL"
  | "PARKING"
  | "INSURANCE"
  | "PERMIT"
  | "FINE"
  | "OTHER";

// Display-friendly category labels. The list page, detail page, and the
// filter <select> all use this mapping. Lives in the web types module
// (not a lib/expense-logs-schema) because iter 21 ships no form; the
// iter-22 write path may move the canonical option list into
// lib/expense-logs-schema.ts alongside the form schemas, the same way
// Customers / Jobs did.
//
// The eight categories are the same eight values the CEO uses on the
// paper expense ledger (see the rationale in the Prisma model
// docstring). Adding a ninth value is a migration + a one-line
// addition here.
export const EXPENSE_CATEGORY_OPTIONS = [
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "REPAIR", label: "Repair" },
  { value: "TOLL", label: "Toll" },
  { value: "PARKING", label: "Parking" },
  { value: "INSURANCE", label: "Insurance" },
  { value: "PERMIT", label: "Permit" },
  { value: "FINE", label: "Fine" },
  { value: "OTHER", label: "Other" },
] as const;

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = Object.fromEntries(
  EXPENSE_CATEGORY_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<ExpenseCategory, string>;

// List-endpoint item: the slim Vehicle + Trip projection. Matches the
// API's LIST_SELECT. Both `vehicle` and `trip` are nullable because
// the FK columns are nullable.
export interface ExpenseLogListItem {
  id: string;
  vehicleId: string | null;
  tripId: string | null;
  date: string;
  category: ExpenseCategory;
  amountPaisa: number;
  vendor: string | null;
  receiptNumber: string | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  vehicle: {
    id: string;
    registrationNumber: string;
  } | null;
  trip: {
    id: string;
  } | null;
}

// Detail-endpoint shape: full nested Vehicle (nullable) + full nested
// Trip (nullable). Reuses the Vehicle type from the sibling slice so a
// Vehicle schema change ripples here automatically. The Trip on an
// ExpenseLog detail page is rendered minimally (id + a deep-link to
// /trips/<id>), so the inline shape is enough; if a future iter adds
// tripNumber to Trip, swap to the Trip type from ../trips/types.
export interface ExpenseLogDetail {
  id: string;
  vehicleId: string | null;
  tripId: string | null;
  date: string;
  category: ExpenseCategory;
  amountPaisa: number;
  vendor: string | null;
  receiptNumber: string | null;
  notes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  vehicle: Vehicle | null;
  trip: {
    id: string;
    vehicleId: string;
    driverId: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    startOdometerKm: number | null;
    endOdometerKm: number | null;
    notes: string | null;
    createdById: string;
    createdAt: string;
    updatedAt: string;
  } | null;
}
