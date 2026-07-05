import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ExpenseCategory } from "@prisma/client";

import type {
  CreateExpenseLogInput,
  ExpenseLogSortColumn,
  ExpenseLogSortDir,
  UpdateExpenseLogInput,
} from "./expense-logs.schemas";

// Re-export the schema-inferred input types so call sites (notably
// the controller and tests) can pull them from this module — the
// same convention FuelLogsService / TripsService / JobsService
// follow.
export type { CreateExpenseLogInput, UpdateExpenseLogInput };

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
   * Plain ExpenseLog lookup without the eager Vehicle/Trip relations — the
   * raw-row getter the agent's update_expense_log pre-image capture needs
   * (ADR-0044 P2: AgentAction.previousJson stores the row itself, not a
   * render shape). Mirror of JobsService.findByIdRaw.
   */
  async findByIdRaw(id: string) {
    return this.prisma.expenseLog.findUnique({ where: { id } });
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

  /**
   * Create an ExpenseLog. `createdById` is supplied by the controller
   * from the authenticated session, not by the client — same
   * convention every other write-path service uses.
   * `CreateExpenseLogSchema.strict()` keeps `createdById` (and any
   * unknown key) off the wire; the service trusts that and uses only
   * fields from `CreateExpenseLogInput`.
   *
   * Unlike FuelLogsService.create, there is no derived field. The
   * caller-supplied `amountPaisa` is the authoritative entered
   * value, not a product of two factors — see the schema docblock
   * for the rationale.
   *
   * Optional FKs:
   *
   *   - `vehicleId` is optional and nullable. A vehicle-agnostic
   *     expense (the quarterly insurance premium, office stationery)
   *     is a legitimate row; the create form exposes an explicit
   *     "(none — not vehicle-attributable)" picker option.
   *
   *   - `tripId` is optional and nullable. An expense may or may
   *     not be paired with a trip (the same pairing flexibility
   *     Fuel logs offers).
   *
   * Cross-field rule (trip-vehicle consistency): fires only when
   * BOTH `tripId` AND `vehicleId` are present. The referenced
   * Trip's `vehicleId` MUST match this expense log's `vehicleId`
   * (a trip for vehicle B cannot have generated an expense
   * attributed to vehicle A). When either is null, the check is
   * skipped — pairing a vehicle-agnostic expense with a trip is
   * allowed, as is logging a vehicle expense without trip
   * attribution. The check is service-layer (not a DB constraint);
   * same precedent as FuelLogsService.assertTripBelongsToVehicle.
   *
   * FK validation (P2003): on a Prisma foreign-key violation we
   * translate to BadRequestException with a per-field message
   * (`vehicleId` / `tripId` / `createdById`). HTTP 400 (not 409) per
   * the runbook — FK-on-create is a client-input error (the picker
   * referenced a deleted or invalid row), not a server-side
   * conflict. The error object's `meta.field_name` tells us which
   * FK; we route by lowercased substring match.
   */
  async create(input: CreateExpenseLogInput, createdById: string): Promise<ExpenseLogDetail> {
    // Service-layer cross-field check before we even attempt the
    // insert. Fires only when BOTH tripId AND vehicleId are
    // non-null on the request — see the docblock above.
    if (input.tripId && input.vehicleId) {
      await this.assertTripBelongsToVehicle(input.tripId, input.vehicleId);
    }

    const data: Prisma.ExpenseLogUncheckedCreateInput = {
      vehicleId: input.vehicleId ?? null,
      tripId: input.tripId ?? null,
      date: input.date,
      category: input.category,
      amountPaisa: input.amountPaisa,
      vendor: input.vendor ?? null,
      receiptNumber: input.receiptNumber ?? null,
      notes: input.notes ?? null,
      createdById,
    };

    try {
      return await this.prisma.expenseLog.create({ data, include: DETAIL_INCLUDE });
    } catch (error) {
      throw mapExpenseLogWriteError(error, {
        vehicleId: input.vehicleId ?? null,
        tripId: input.tripId ?? null,
        createdById,
      });
    }
  }

  /**
   * Diff-PATCH an ExpenseLog. Mirrors FuelLogsService.update /
   * JobsService.update in shape:
   *
   *   1. Fetch the existing row (404 if missing, surfaced as
   *      NotFoundException). We need the existing row for the
   *      trip-vehicle consistency check's merged-shape comparison.
   *
   *   2. If `tripId` is present in the PATCH and resolves to a
   *      non-null value AND the EXISTING row's vehicleId is
   *      non-null (vehicleId is immutable on PATCH), re-run the
   *      trip-vehicle consistency check against the MERGED shape
   *      (patch's tripId paired with existing row's vehicleId).
   *      When either side of the merged shape is null, the check
   *      is skipped — same skip-when-either-is-null rule as create.
   *
   *   3. Let Prisma do the write. P2003 → BadRequestException
   *      (only tripId can flip from null to non-null on PATCH;
   *      vehicleId is rejected at the schema layer). P2025 →
   *      NotFoundException (rare; only if a concurrent DELETE
   *      landed between step 1 and the update).
   *
   * Returns the expense log's DETAIL_INCLUDE shape so the controller
   * can respond with the same shape that GET /api/v1/expense-logs/:id
   * returns.
   *
   * `vehicleId` is not accepted by UpdateExpenseLogSchema (the
   * `.strict()` + absence-from-shape rejects it). See the schema's
   * docblock for the immutability rationale.
   */
  async update(id: string, input: UpdateExpenseLogInput): Promise<ExpenseLogDetail> {
    const existing = await this.prisma.expenseLog.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Expense log ${id} not found`);
    }

    const has = (key: keyof UpdateExpenseLogInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    // Trip-vehicle consistency on the merged shape. vehicleId is
    // immutable on PATCH so the comparison value is the existing
    // row's vehicleId. The check fires only when BOTH sides of the
    // merged shape are non-null: the patch's tripId is set to a
    // non-null value AND the existing row already has a vehicleId.
    // Same skip-when-either-is-null rule as create.
    if (has("tripId") && input.tripId && existing.vehicleId) {
      await this.assertTripBelongsToVehicle(input.tripId, existing.vehicleId);
    }

    const data: Prisma.ExpenseLogUpdateInput = {
      ...(has("tripId") && {
        trip: input.tripId ? { connect: { id: input.tripId } } : { disconnect: true },
      }),
      ...(has("date") && input.date !== undefined && { date: input.date }),
      ...(has("category") && input.category !== undefined && { category: input.category }),
      ...(has("amountPaisa") &&
        input.amountPaisa !== undefined && { amountPaisa: input.amountPaisa }),
      ...(has("vendor") && { vendor: input.vendor ?? null }),
      ...(has("receiptNumber") && { receiptNumber: input.receiptNumber ?? null }),
      ...(has("notes") && { notes: input.notes ?? null }),
    };

    try {
      return await this.prisma.expenseLog.update({
        where: { id },
        data,
        include: DETAIL_INCLUDE,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
        // Either the ExpenseLog row vanished between findUnique
        // and the update (rare; concurrent DELETE) or the PATCH
        // disconnected and reconnected to a now-deleted trip. The
        // trip case is additionally guarded by
        // assertTripBelongsToVehicle above which would have
        // surfaced a 400 first when both sides are non-null.
        throw new NotFoundException(`Expense log ${id} not found`);
      }
      throw mapExpenseLogWriteError(error, {
        vehicleId: existing.vehicleId,
        tripId: input.tripId ?? null,
      });
    }
  }

  /**
   * Hard delete an ExpenseLog. P2025 (delete targets a non-existent
   * row) maps to NotFoundException.
   *
   * P2003 (FK violation) maps to ConflictException (HTTP 409): a
   * ServiceRecord references this expense via its `onDelete: Restrict`
   * `expenseLogId` cost-link FK (ADR-0037 c6, B4) — so a linked
   * maintenance/repair expense cannot be silently deleted out from
   * under the service record it documents the cost of. This is the
   * SAME delete-blocker treatment the Customer / Vehicle deletes have,
   * and is exactly the P2003 → ConflictException arm this method's
   * iter-22 docstring anticipated once a Restrict FK pointed at
   * ExpenseLog. The message is the GENERIC "referenced by other
   * records." shape (mirroring CustomersService.delete) — ServiceRecord
   * is the only referencer today, but naming it specifically would cost
   * an extra query and would mislead if a second referencer is added.
   *
   * Returns void on success; the controller responds 204 No
   * Content.
   */
  async delete(id: string): Promise<void> {
    try {
      await this.prisma.expenseLog.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2025") {
          throw new NotFoundException(`Expense log ${id} not found`);
        }
        if (error.code === "P2003") {
          throw new ConflictException(
            "Cannot delete expense log: it is referenced by other records.",
          );
        }
      }
      throw error;
    }
  }

  /**
   * Look up the trip and assert its `vehicleId` matches the
   * supplied one. Throws BadRequestException with both registration
   * numbers named on mismatch, and a generic "trip not found"
   * BadRequest on a missing trip (the Prisma FK would also catch a
   * missing trip on insert as P2003, but surfacing the
   * service-layer check up front makes the error message friendlier
   * — the operator sees "Trip <id> does not exist" instead of a
   * stale-FK framing).
   *
   * The trip lookup pulls the vehicle's registrationNumber via a
   * nested select so the error message can name it; if the trip's
   * vehicle is missing somehow (it shouldn't be — Trip.vehicleId is
   * NOT NULL and Vehicle deletes are Restrict-blocked), we fall
   * back to ids.
   *
   * Mirror of FuelLogsService.assertTripBelongsToVehicle. Both
   * sides are guaranteed non-null at the call sites (create /
   * update guard with `if (input.tripId && input.vehicleId)` and
   * `if (has("tripId") && input.tripId && existing.vehicleId)`).
   */
  private async assertTripBelongsToVehicle(tripId: string, vehicleId: string): Promise<void> {
    const trip = await this.prisma.trip.findUnique({
      where: { id: tripId },
      select: {
        id: true,
        vehicleId: true,
        vehicle: { select: { registrationNumber: true } },
      },
    });
    if (!trip) {
      throw new BadRequestException(`Trip ${tripId} does not exist.`);
    }
    if (trip.vehicleId !== vehicleId) {
      const thisVehicle = await this.prisma.vehicle.findUnique({
        where: { id: vehicleId },
        select: { registrationNumber: true },
      });
      const tripRegistration = trip.vehicle?.registrationNumber ?? trip.vehicleId;
      const thisRegistration = thisVehicle?.registrationNumber ?? vehicleId;
      throw new BadRequestException(
        `Trip ${tripId} is for vehicle ${tripRegistration}, not vehicle ${thisRegistration}.`,
      );
    }
  }
}

/**
 * Translate a Prisma write error into a domain-level exception. The
 * iter-22 kickoff §"FK validation mapping" follows the Fuel logs
 * iter-20 precedent: P2003 on `vehicleId` / `tripId` /
 * `createdById` surfaces as HTTP 400 with the offending id named
 * verbatim in the message. The web action layer parses the message
 * to route the inline error back to the right form field.
 *
 * Unknown FK names fall back to a generic 400 that names the
 * vehicleId when one was supplied (the more common picker error);
 * when vehicleId is null (a vehicle-agnostic create) we name the
 * tripId, which is the only remaining client-supplied FK.
 *
 * Errors that aren't recognized propagate unchanged so NestJS's
 * default exception filter can map them to 500.
 */
function mapExpenseLogWriteError(
  error: unknown,
  context: { vehicleId: string | null; tripId: string | null; createdById?: string },
): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
    const meta = error.meta as { field_name?: string; constraint?: string } | undefined;
    const fieldName = String(meta?.field_name ?? meta?.constraint ?? "").toLowerCase();
    if (fieldName.includes("trip")) {
      return new BadRequestException(`Trip ${context.tripId ?? "?"} does not exist.`);
    }
    if (fieldName.includes("createdby") && context.createdById) {
      return new BadRequestException(
        `Authenticated user "${context.createdById}" no longer exists; sign in again.`,
      );
    }
    if (fieldName.includes("vehicle")) {
      return new BadRequestException(`Vehicle ${context.vehicleId ?? "?"} does not exist.`);
    }
    // Unknown FK name — name the supplied id that the operator's
    // picker most likely staled. The web action layer parses the
    // message to route the inline error to the right form field.
    if (context.vehicleId) {
      return new BadRequestException(`Vehicle ${context.vehicleId} does not exist.`);
    }
    if (context.tripId) {
      return new BadRequestException(`Trip ${context.tripId} does not exist.`);
    }
  }
  return error;
}
