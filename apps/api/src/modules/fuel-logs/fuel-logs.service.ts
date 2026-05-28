import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import type { FuelLogSortColumn, FuelLogSortDir } from "./fuel-logs.schemas";

// PrismaService is injected by NestJS via TypeScript's
// emitDecoratorMetadata (see apps/api/tsconfig.json); the class
// reference must remain a value import at runtime so the DI container
// can resolve it. Same eslint override as the Vehicles / Drivers /
// Trips / Customers / Jobs services.
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
// the date, the vehicle's registration number (mono badge), the
// liters / price / total triplet, and link-throughs to the related
// trip (when present). Pulling only those fields via a nested Prisma
// `select` is cheaper than eager-loading the full Vehicle and Trip
// objects, and keeps the wire payload small as the book grows. The
// detail endpoint uses the broader DETAIL_INCLUDE shape with the full
// nested Vehicle and Trip objects so the detail page can render every
// field and deep-link back to /vehicles/<id> and /trips/<id>.
//
// The Prisma `select` literal below is the runtime authority for what
// the list endpoint returns; the FuelLogListItem type derived from it
// shapes the wire response from this same select. When the two
// diverge, TypeScript catches the drift at the call site rather than
// silently dropping fields.
const LIST_SELECT = {
  id: true,
  vehicleId: true,
  tripId: true,
  date: true,
  litersMl: true,
  pricePerLiterPaisa: true,
  totalCostPaisa: true,
  odometerReadingKm: true,
  station: true,
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
  // Trip relation is nullable on FuelLog (the FK is `tripId String?`);
  // Prisma's select on a nullable relation returns the selected shape
  // or null. We project a minimal id-only handle (Trip has no
  // human-readable number on Phase-1 Trips today — the glossary entry
  // for Trip notes this; if a future iter adds a tripNumber, this
  // select is the file to update alongside the web detail page).
  trip: {
    select: {
      id: true,
    },
  },
} satisfies Prisma.FuelLogSelect;

// The list item shape — derived from LIST_SELECT via Prisma's
// validator helper. Exported so the controller's response type and
// the tests can share the precise shape. Same pattern as
// JobsService.JobListItem.
export type FuelLogListItem = Prisma.FuelLogGetPayload<{ select: typeof LIST_SELECT }>;

// The detail shape — full FuelLog + full nested Vehicle + full nested
// Trip (when present). The Vehicle relation is required on every
// FuelLog (the schema's FK is NOT NULL), so the include never
// produces null for it. The Trip relation IS nullable; Prisma returns
// null for it when `tripId` is null, and the detail page renders the
// "Trip" section conditionally on that.
const DETAIL_INCLUDE = {
  vehicle: true,
  trip: true,
} satisfies Prisma.FuelLogInclude;

export type FuelLogDetail = Prisma.FuelLogGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: FuelLogListItem[];
  total: number;
}

@Injectable()
export class FuelLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List fuel logs with optional filter / sort / pagination. The list
   * endpoint returns the slim projection (LIST_SELECT) so the wire
   * payload stays small even as the book grows; the detail endpoint
   * uses getById with the broader DETAIL_INCLUDE shape.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * fill first by `date`. `date` is the natural sort for a fuel
   * ledger ("when was the most recent fill?"), and the schema's
   * `(date desc)` partial index makes the default cheap.
   *
   * `vehicleId` and `tripId` are scalar equality filters; unknown ids
   * naturally produce empty result sets, which is the right UX for
   * "fuel for this vehicle / trip" URLs that survive a deleted
   * referent (although the schema's onDelete: Restrict prevents the
   * vehicle case today, and the iter-20 write path will surface a
   * friendly 409 on the trip case when the time comes). `startDate`
   * and `endDate` are inclusive bounds on the `date` column.
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListFuelLogsQuerySchema`, but the service is
   * also called from inside other modules' code paths in future
   * slices (a "recent fuel" sidebar on the Vehicle detail page, for
   * example), and a clamp here ensures the database is never asked
   * for an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    vehicleId,
    tripId,
    startDate,
    endDate,
    sortBy = "date",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    vehicleId?: string;
    tripId?: string;
    startDate?: Date;
    endDate?: Date;
    sortBy?: FuelLogSortColumn;
    sortDir?: FuelLogSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count
    // so `total` matches what findMany would return at skip=0/take=∞.
    // Each filter is included only when present so omitted filters
    // don't generate noisy `where` clauses Prisma has to optimize
    // around.
    const dateRange: Prisma.DateTimeFilter = {};
    if (startDate) dateRange.gte = startDate;
    if (endDate) dateRange.lte = endDate;
    const hasDateRange = startDate !== undefined || endDate !== undefined;

    const where: Prisma.FuelLogWhereInput = {
      ...(vehicleId ? { vehicleId } : {}),
      ...(tripId ? { tripId } : {}),
      ...(hasDateRange ? { date: dateRange } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-
    // breaker on id so paginated results are stable across requests
    // even when two rows share the primary sort value (e.g., two
    // fills logged with the same `date` value). Same pattern as the
    // Jobs / Trips orderBy construction.
    const orderBy: Prisma.FuelLogOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.FuelLogOrderByWithRelationInput,
      { id: sortDir } as Prisma.FuelLogOrderByWithRelationInput,
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.fuelLog.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: LIST_SELECT,
      }),
      this.prisma.fuelLog.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one fuel log by id with the related Vehicle and Trip
   * eager-loaded for the detail page. The controller wraps a null
   * return into NotFoundException so this method stays usable from
   * other modules without exception handling for the not-found path
   * — same shape the Jobs / Customers services use. Returns
   * FuelLogDetail (with Vehicle always present, Trip nullable).
   */
  async findById(id: string): Promise<FuelLogDetail | null> {
    return this.prisma.fuelLog.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
  }

  /**
   * Fetch one fuel log by id with the relations eager-loaded, or
   * throw NotFoundException. Convenience wrapper used by the
   * controller's GET /:id handler so the 404 shape lives in the
   * service rather than being duplicated at every controller method.
   * The NotFoundException message echoes the id so an operator who
   * mistyped a URL sees what they asked for. Mirror of
   * JobsService.getById.
   */
  async getById(id: string): Promise<FuelLogDetail> {
    const row = await this.findById(id);
    if (!row) {
      throw new NotFoundException(`Fuel log ${id} not found`);
    }
    return row;
  }
}
