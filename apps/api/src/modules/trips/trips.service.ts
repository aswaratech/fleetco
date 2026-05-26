import { Injectable } from "@nestjs/common";
import type { Prisma, Trip, TripStatus } from "@prisma/client";

import type { TripSortColumn, TripSortDir } from "./trips.schemas";

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it. Same eslint
// override as the Vehicles and Drivers services.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// Pagination defaults and bounds. Same `LIST_TAKE_` prefix as the
// Drivers service (the iter-6 kickoff named the convention explicitly).
// The take cap (200) matches the Drivers and Vehicles caps; the
// minimum take (1) prevents the degenerate count-only request through
// this endpoint.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Slim projection used by the list endpoint. The list page renders
// the vehicle's registration number and the driver's full name next
// to each trip row; pulling those two fields via Prisma `select` is
// cheaper than eager-loading the full Vehicle / Driver objects, and
// keeps the wire payload small as fleets grow. The detail endpoint
// uses the broader `findById` shape with full nested objects so the
// detail page can render every field.
//
// The Prisma `select` literal below is the runtime authority for what
// the list endpoint returns; the controller's TripListItem type
// (trips.controller.ts) shapes the wire response from this same
// select. When the two diverge, the controller's TypeScript type
// catches the drift at the call site rather than silently dropping
// fields.
const LIST_SELECT = {
  id: true,
  vehicleId: true,
  driverId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  startOdometerKm: true,
  endOdometerKm: true,
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
  driver: {
    select: {
      id: true,
      fullName: true,
    },
  },
} satisfies Prisma.TripSelect;

// The list item shape — derived from LIST_SELECT via Prisma's
// validator helper. Exported so the controller's response type and
// the tests can share the precise shape.
export type TripListItem = Prisma.TripGetPayload<{ select: typeof LIST_SELECT }>;

// The detail shape — full Trip + full nested Vehicle + full nested
// Driver. Both relations are required on every Trip (the schema's FK
// is NOT NULL), so the include never produces nulls for them.
const DETAIL_INCLUDE = {
  vehicle: true,
  driver: true,
} satisfies Prisma.TripInclude;

export type TripDetail = Prisma.TripGetPayload<{ include: typeof DETAIL_INCLUDE }>;

export interface ListResult {
  items: TripListItem[];
  total: number;
}

@Injectable()
export class TripsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List trips with optional filter / sort / pagination. The list
   * endpoint returns the slim projection (LIST_SELECT) so the wire
   * payload stays small even as fleets grow; the detail endpoint
   * uses findById with the broader DETAIL_INCLUDE shape.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * first by createdAt — matches the Drivers and Vehicles surfaces
   * and the iter-4 list-page convention. The `id` secondary tiebreaker
   * (when createdAt itself is the primary) or the `createdAt`
   * secondary (when any other column is primary) is preserved so
   * paginated results are deterministic — without it, two rows with
   * identical primary sort values can flip between page loads and
   * either duplicate or skip a row. `startedAt` and `endedAt` are
   * nullable; Prisma's default null-ordering sorts nulls last in asc
   * and first in desc, which is the right shape for "most recently
   * started first" (planned trips with no start time slide to the end
   * of a desc sort, where they make sense as "not yet started").
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListTripsQuerySchema`, but the service is also
   * called from inside other modules' code paths in future slices
   * (e.g., a "trips for this driver" sidebar on the driver detail
   * page), and a clamp here ensures the database is never asked for
   * an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    vehicleId,
    driverId,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: TripStatus[];
    vehicleId?: string;
    driverId?: string;
    sortBy?: TripSortColumn;
    sortDir?: TripSortDir;
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
    // the schema. vehicleId / driverId are scalar equality filters; an
    // unknown id naturally produces an empty result set, which is the
    // right UX for "trips for this vehicle" URLs that survive a
    // deleted vehicle (when soft-delete or block-when-referenced lands
    // per the tech-debt entry on cross-aggregate deletes).
    const where: Prisma.TripWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(vehicleId ? { vehicleId } : {}),
      ...(driverId ? { driverId } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-
    // breaker on createdAt (or id, when createdAt itself is the
    // primary) so paginated results are stable across requests.
    const orderBy: Prisma.TripOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.TripOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.TripOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.TripOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.trip.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        select: LIST_SELECT,
      }),
      this.prisma.trip.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one trip by id with the related Vehicle and Driver
   * eager-loaded for the detail page. Returns `null` when not found
   * rather than throwing, so the controller can shape the 404 response
   * and the service stays usable from other modules without exception
   * handling for the not-found path.
   *
   * The eager include is the contract under test: the iter-8 detail
   * page expects both nested objects to be present, and Prisma's
   * required-FK guarantees they are. A refactor that changes the
   * include shape (e.g., dropping `driver` to a slim `select`) would
   * need to update both the service-level test and the controller-
   * level response type in the same commit.
   */
  async findById(id: string): Promise<TripDetail | null> {
    return this.prisma.trip.findUnique({
      where: { id },
      include: DETAIL_INCLUDE,
    });
  }

  /**
   * Plain Trip lookup without the eager relations — exposed for the
   * future iter-9 write path's PATCH route (which needs the existing
   * row but does not need to render the nested objects) and for tests
   * that want to assert the raw row shape. The Phase-1 service
   * surface is small enough that exposing both shapes is cheaper than
   * an internal-only flag on findById.
   */
  async findByIdRaw(id: string): Promise<Trip | null> {
    return this.prisma.trip.findUnique({ where: { id } });
  }
}
