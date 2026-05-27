import { Injectable } from "@nestjs/common";
import type { Customer, CustomerStatus, Prisma } from "@prisma/client";

import type { CustomerSortColumn, CustomerSortDir } from "./customers.schemas";

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it. Same eslint
// override as the Drivers and Vehicles services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: Customer[];
  total: number;
}

// Pagination defaults and bounds. Names match the iter-15 kickoff
// (`LIST_TAKE_DEFAULT` / `LIST_TAKE_MAX`) and the iter-6 Drivers
// service naming, so the two surfaces stay grep-symmetric. The take
// cap (200) matches the Drivers and Vehicles caps; the minimum take
// (1) prevents the degenerate count-only request through this endpoint.
//
// LIST_TAKE_MAX is defense-in-depth: the controller validates `take`
// against the same ceiling via `ListCustomersQuerySchema`, but the
// service is also reachable from future internal callers (the Jobs
// slice will fetch a customer by id during job creation), and a clamp
// here ensures the database is never asked for an unbounded result
// regardless of how the call site reaches the service.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List customers. Supports filtering by status, sorting by a
   * whitelisted column, and pagination. `total` reflects the filtered
   * count so the UI can render correct "Showing M–N of T" copy and
   * disable next-page at the edge.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * first by createdAt. `sortBy=createdAt, sortDir=desc` matches the
   * Drivers and Vehicles surfaces and the established list-page
   * convention. The `id` secondary tiebreaker (when createdAt itself
   * is the primary) or the `createdAt` secondary (when any other
   * column is primary) is preserved so paginated results are
   * deterministic — without it, two rows with identical primary sort
   * values can flip between page loads and either duplicate or skip
   * a row.
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as a defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListCustomersQuerySchema`, but the service may
   * also be called from inside other modules' code paths in future
   * slices (the Jobs slice will fetch a customer by id during job
   * creation), and a clamp here ensures the database is never asked
   * for an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: CustomerStatus[];
    sortBy?: CustomerSortColumn;
    sortDir?: CustomerSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the WHERE clause once; reuse it for both findMany and count
    // so `total` matches what findMany would return at skip=0/take=∞.
    // Empty arrays should not produce `in: []` (which would match zero
    // rows in Prisma) — the schema's csvEnum normalizes those to
    // `undefined`, but a belt-and-braces check here keeps the service
    // robust against any future direct caller that doesn't go through
    // the schema.
    const where: Prisma.CustomerWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
    };

    // Primary sort by the requested column + direction; secondary
    // tie-breaker on createdAt (or id, when createdAt itself is the
    // primary) so paginated results are stable across requests. Same
    // shape as DriversService.list and VehiclesService.list.
    const orderBy: Prisma.CustomerOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.CustomerOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.CustomerOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.CustomerOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({ skip: safeSkip, take: safeTake, where, orderBy }),
      this.prisma.customer.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one customer by id. Returns `null` when not found rather
   * than throwing, so the controller can shape the 404 response and
   * the service stays usable from other modules without exception
   * handling for the not-found path. (The future Jobs slice will call
   * this during job creation; an internal caller seeing `null` is
   * more useful than an internal caller catching NotFoundException.)
   */
  async findById(id: string): Promise<Customer | null> {
    return this.prisma.customer.findUnique({ where: { id } });
  }
}
