import { Injectable, NotFoundException } from "@nestjs/common";
import type { ExpenseCategory, Prisma } from "@prisma/client";

import type { ExpenseLogSortColumn, ExpenseLogSortDir } from "./expense-logs.schemas";

// PrismaService is injected by NestJS via TypeScript's
// emitDecoratorMetadata (see apps/api/tsconfig.json); the class
// reference must remain a value import at runtime so the DI container
// can resolve it. Same eslint override as every other vertical-slice
// service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// Pagination defaults and bounds. Same `LIST_TAKE_` prefix as every
// other vertical-slice service (the iter-6 kickoff named the
// convention explicitly and every subsequent slice has matched it).
// The take cap (200) matches the precedent; the minimum take (1)
// prevents the degenerate count-only request through this endpoint.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Slim projection used by the list endpoint. The list page renders
// the date, the vehicle's registration number (mono badge, or em-
// dash when null — the vehicle-agnostic-expense case), the trip's id
// (or em-dash when null), the category label, and the amount. Pulling
// only those fields via a nested Prisma `select` is cheaper than
// eager-loading the full Vehicle and Trip objects, and keeps the wire
// payload small as the ledger grows. The detail endpoint uses the
// broader DETAIL_INCLUDE shape with the full nested Vehicle and Trip
// objects so the detail page can render every field and deep-link
// back to /vehicles/<id> and /trips/<id>.
//
// `vehicle` is nullable in the projection (Prisma returns null for
// the relation when the FK is null) — same shape Fuel logs uses for
// its nullable `trip` projection. The web list page renders the
// vehicle registration with an em-dash when `vehicle === null`.
const LIST_SELECT = {
  id: true,
  vehicleId: true,
  tripId: true,
  date: true,
  category: true,
  amountPaisa: true,
  vendor: true,
  receiptNumber: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  vehicle: {
    select: {
      id: true,
      registrationNumber: true,
    },
  },
  // Trip relation is nullable on ExpenseLog (the FK is `tripId
  // String?`); Prisma's select on a nullable relation returns the
  // selected shape or null. The list projection only needs the id
  // (a click-through to the trip detail page is the natural pivot
  // when the operator wants more context); the detail-include
  // projection below surfaces the full trip shape so the detail
  // page can render the trip block inline.
  trip: {
    select: {
      id: true,
    },
  },
} satisfies Prisma.ExpenseLogSelect;

// The list item shape — derived from LIST_SELECT via Prisma's
// validator helper. Exported so the controller's response type and
// the tests can share the precise shape. Same pattern as
// FuelLogsService.FuelLogListItem.
export type ExpenseLogListItem = Prisma.ExpenseLogGetPayload<{ select: typeof LIST_SELECT }>;

// The detail shape — full ExpenseLog + full nested Vehicle (nullable)
// + full nested Trip (nullable). Both relations are nullable on
// ExpenseLog (the FK columns are `vehicleId String?` and `tripId
// String?`); Prisma returns null for either when the corresponding
// FK is null. The web detail page renders the Vehicle block as
// "Not vehicle-attributable" and the Trip block is omitted when null.
const DETAIL_INCLUDE = {
  vehicle: true,
  trip: true,
} satisfies Prisma.ExpenseLogInclude;

export type ExpenseLogDetail = Prisma.ExpenseLogGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: ExpenseLogListItem[];
  total: number;
}

@Injectable()
export class ExpenseLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List expense logs with optional filter / sort / pagination. The
   * list endpoint returns the slim projection (LIST_SELECT) so the
   * wire payload stays small even as the ledger grows; the detail
   * endpoint uses findById with the broader DETAIL_INCLUDE shape.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * expense first by `date`. `date` is the natural sort for an
   * expense ledger ("when was the most recent payment?"), and the
   * schema's `(date desc)` partial index makes the default cheap.
   *
   * `vehicleId`, `tripId`, and `category` are scalar equality
   * filters; unknown ids naturally produce empty result sets. The
   * `vehicleId` filter is positive-equality only (it matches rows
   * where vehicleId equals the supplied id); asking for "the
   * vehicle-agnostic feed" (vehicleId IS NULL) is not exposed in
   * iter 21's list endpoint — the iter-23 cost report will surface
   * that bucket via its own endpoint. `startDate` and `endDate` are
   * inclusive bounds on the `date` column.
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX =
   * 200`) as defense-in-depth: the controller validates `take`
   * against the same ceiling via `ListExpenseLogsQuerySchema`, but
   * the service is also called from inside other modules' code paths
   * in future slices (a "recent expenses" sidebar on the Vehicle
   * detail page, for example), and a clamp here ensures the database
   * is never asked for an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    vehicleId,
    tripId,
    category,
    startDate,
    endDate,
    sortBy = "date",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    vehicleId?: string;
    tripId?: string;
    category?: ExpenseCategory;
    startDate?: Date;
    endDate?: Date;
    sortBy?: ExpenseLogSortColumn;
    sortDir?: ExpenseLogSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and
    // count so `total` matches what findMany would return at
    // skip=0/take=∞. Each filter is included only when present so
    // omitted filters don't generate noisy `where` clauses Prisma
    // has to optimize around.
    const dateRange: Prisma.DateTimeFilter = {};
    if (startDate) dateRange.gte = startDate;
    if (endDate) dateRange.lte = endDate;
    const hasDateRange = startDate !== undefined || endDate !== undefined;

    const where: Prisma.ExpenseLogWhereInput = {
      ...(vehicleId ? { vehicleId } : {}),
      ...(tripId ? { tripId } : {}),
      ...(category ? { category } : {}),
      ...(hasDateRange ? { date: dateRange } : {}),
    };

    // Primary sort by the requested column + direction; secondary
    // tie-breaker on id so paginated results are stable across
    // requests even when two rows share the primary sort value
    // (e.g., two expenses logged with the same `date` value). Same
    // pattern as the Fuel logs / Jobs orderBy construction.
    const orderBy: Prisma.ExpenseLogOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.ExpenseLogOrderByWithRelationInput,
      { id: sortDir } as Prisma.ExpenseLogOrderByWithRelationInput,
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.expenseLog.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: LIST_SELECT,
      }),
      this.prisma.expenseLog.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one expense log by id with the related Vehicle and Trip
   * eager-loaded for the detail page. The controller wraps a null
   * return into NotFoundException so this method stays usable from
   * other modules without exception handling for the not-found path
   * — same shape the Fuel logs / Jobs / Customers services use.
   * Returns ExpenseLogDetail (with Vehicle nullable, Trip nullable
   * — both FK columns are optional on ExpenseLog).
   */
  async findById(id: string): Promise<ExpenseLogDetail | null> {
    return this.prisma.expenseLog.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
  }

  /**
   * Fetch one expense log by id with the relations eager-loaded, or
   * throw NotFoundException. Convenience wrapper used by the
   * controller's GET /:id handler so the 404 shape lives in the
   * service rather than being duplicated at every controller method.
   * The NotFoundException message echoes the id so an operator who
   * mistyped a URL sees what they asked for. Mirror of
   * FuelLogsService.getById.
   */
  async getById(id: string): Promise<ExpenseLogDetail> {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException(`Expense log ${id} not found`);
    }
    return row;
  }
}
