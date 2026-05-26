import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma, type Driver, DriverStatus, type LicenseClass } from "@prisma/client";

import type {
  CreateDriverInput,
  DriverSortColumn,
  DriverSortDir,
  UpdateDriverInput,
} from "./drivers.schemas";

// Re-export the schema-inferred types so existing call sites that
// import { CreateDriverInput, UpdateDriverInput } from this module
// (notably the iter-6 test suites) keep working without churn. The
// authoritative shape lives next to the schema in drivers.schemas.ts;
// the iter-7 refactor replaced the local interface declarations with
// these imports per the kickoff item 1.
export type { CreateDriverInput, UpdateDriverInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it. Same eslint
// override as the Vehicles service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: Driver[];
  total: number;
}

// Pagination defaults and bounds. Names are spelled with the
// `LIST_TAKE_` prefix the iter-6 kickoff names explicitly, which is a
// small departure from the Vehicles spelling (`DEFAULT_TAKE` /
// `MAX_TAKE`). The two are aliased in the export below so a future
// promotion to a shared `apps/api/src/common/pagination.ts` file does
// not require breaking either set of imports. The take cap (200)
// matches the Vehicles cap; the minimum take (1) prevents the
// degenerate count-only request through this endpoint.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Aliases for the Vehicles-style names. Pure convenience for future
// readers grep-ping for either spelling.
export const DEFAULT_TAKE = LIST_TAKE_DEFAULT;
export const MAX_TAKE = LIST_TAKE_MAX;

// Prisma's unique-constraint violation code. Surface as HTTP 409 rather
// than 500 so the client can render a clear inline message. The
// translation is documented in docs/runbook/api-error-mapping.md and
// applied identically to Vehicles' registrationNumber and Drivers'
// licenseNumber. The runbook also names HGMV-equivalent future unique
// columns (Customers' PAN, Vendors' registration) so they hit this
// same translation when they arrive.
const PRISMA_UNIQUE_VIOLATION = "P2002";

function isPrismaUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_VIOLATION
  );
}

@Injectable()
export class DriversService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List drivers. Supports filtering by status and licenseClass, sorting
   * by a whitelisted column, and pagination. `total` reflects the
   * filtered count so the UI can render correct "Showing M–N of T" copy
   * and disable next-page at the edge.
   *
   * Defaults (when the caller passes no overrides): 20 rows, newest
   * first by createdAt. `sortBy=createdAt, sortDir=desc` matches the
   * Vehicles surface and the iter-4 list-page convention. The `id`
   * secondary tiebreaker (when createdAt itself is the primary) or
   * the `createdAt` secondary (when any other column is primary) is
   * preserved so paginated results are deterministic — without it, two
   * rows with identical primary sort values can flip between page
   * loads and either duplicate or skip a row.
   *
   * `skip` and `take` are clamped to safe bounds (`LIST_TAKE_MAX = 200`)
   * as a defense-in-depth: the controller validates `take` against the
   * same ceiling via `ListDriversQuerySchema`, but the service is also
   * called from inside other modules' code paths in future slices
   * (e.g., the Trips slice will fetch a driver by id during trip
   * creation), and a clamp here ensures the database is never asked
   * for an unbounded result.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    licenseClass,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: DriverStatus[];
    licenseClass?: LicenseClass[];
    sortBy?: DriverSortColumn;
    sortDir?: DriverSortDir;
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
    const where: Prisma.DriverWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(licenseClass && licenseClass.length > 0 ? { licenseClass: { in: licenseClass } } : {}),
    };

    // Primary sort by the requested column + direction; secondary tie-
    // breaker on createdAt (or id, when createdAt itself is the primary)
    // so paginated results are stable across requests.
    const orderBy: Prisma.DriverOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.DriverOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.DriverOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.DriverOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.driver.findMany({ skip: safeSkip, take: safeTake, where, orderBy }),
      this.prisma.driver.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one driver by id. Returns `null` when not found rather than
   * throwing, so the controller can shape the 404 response and the
   * service stays usable from other modules without exception handling
   * for the not-found path. (The Trips slice will call this during
   * trip creation; an internal caller seeing `null` is more useful
   * than an internal caller catching NotFoundException.)
   */
  async findById(id: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id } });
  }

  /**
   * Create a Driver. `createdById` is supplied by the controller from
   * the authenticated session, not by the client. The iter-7 create
   * schema will reject unknown keys via `.strict()`, but the service
   * itself does not depend on that — it accepts only fields from
   * CreateDriverInput.
   *
   * Defaults applied at the service layer:
   *   - `status` defaults to `ACTIVE`.
   *   - `dateOfBirth` is optional; the service stores null when absent.
   * Throws ConflictException (HTTP 409) on unique-constraint violation
   * of licenseNumber per docs/runbook/api-error-mapping.md; everything
   * else propagates and Nest's default exception filter renders 500.
   */
  async create(input: CreateDriverInput, createdById: string): Promise<Driver> {
    const data: Prisma.DriverUncheckedCreateInput = {
      fullName: input.fullName,
      licenseNumber: input.licenseNumber,
      licenseClass: input.licenseClass,
      phone: input.phone,
      dateOfBirth: input.dateOfBirth ?? null,
      hiredAt: input.hiredAt,
      licenseExpiresAt: input.licenseExpiresAt,
      status: input.status ?? DriverStatus.ACTIVE,
      createdById,
    };

    try {
      return await this.prisma.driver.create({ data });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ConflictException(
          `A driver with license number "${input.licenseNumber}" already exists.`,
        );
      }
      throw error;
    }
  }

  /**
   * Partial update. The iter-7 controller's validation will guarantee
   * the body is non-empty and contains only mutable fields; this iter
   * exposes update() for tests of the terminatedAt-transition rule
   * (the rule is service-layer policy and the iter-6 tests verify it
   * end-to-end against the real database).
   *
   * Terminated-transition rule (mirrors Vehicle.retiredAt):
   *
   *   - Transition INTO TERMINATED: set terminatedAt to the client's
   *     value if provided, otherwise to `new Date()`.
   *   - Transition OUT of TERMINATED back to ACTIVE/ON_LEAVE/SUSPENDED:
   *     clear terminatedAt unless the client explicitly provided one
   *     (an unusual but legitimate case — e.g., correcting a
   *     historical record where the driver was terminated and rehired).
   *   - No status change: respect terminatedAt only if the client
   *     passed it explicitly; otherwise leave the stored value alone.
   *
   * The fourth direction the iter-6 tests verify is the no-op case
   * (status change between two non-TERMINATED values does not touch
   * terminatedAt). The rule's symmetric design and the four-test
   * matrix together pin the behavior across the future Drivers
   * write-path UI surface.
   *
   * Returns null when the driver is not found, mirroring findById's
   * shape so the controller can shape the 404 response.
   */
  async update(id: string, input: UpdateDriverInput): Promise<Driver | null> {
    const existing = await this.prisma.driver.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }

    const clientProvidedTerminatedAt = Object.prototype.hasOwnProperty.call(input, "terminatedAt");
    let derivedTerminatedAt: Date | null | undefined;
    if (!clientProvidedTerminatedAt && input.status !== undefined) {
      const transitioningIntoTerminated =
        input.status === DriverStatus.TERMINATED && existing.status !== DriverStatus.TERMINATED;
      const transitioningOutOfTerminated =
        input.status !== DriverStatus.TERMINATED && existing.status === DriverStatus.TERMINATED;
      if (transitioningIntoTerminated) {
        derivedTerminatedAt = new Date();
      } else if (transitioningOutOfTerminated) {
        derivedTerminatedAt = null;
      }
    }

    const data: Prisma.DriverUpdateInput = {
      ...(input.fullName !== undefined && { fullName: input.fullName }),
      ...(input.licenseNumber !== undefined && { licenseNumber: input.licenseNumber }),
      ...(input.licenseClass !== undefined && { licenseClass: input.licenseClass }),
      ...(input.phone !== undefined && { phone: input.phone }),
      ...(Object.prototype.hasOwnProperty.call(input, "dateOfBirth") && {
        dateOfBirth: input.dateOfBirth ?? null,
      }),
      ...(input.hiredAt !== undefined && { hiredAt: input.hiredAt }),
      ...(input.licenseExpiresAt !== undefined && { licenseExpiresAt: input.licenseExpiresAt }),
      ...(input.status !== undefined && { status: input.status }),
      ...(clientProvidedTerminatedAt
        ? { terminatedAt: input.terminatedAt ?? null }
        : derivedTerminatedAt !== undefined && { terminatedAt: derivedTerminatedAt }),
    };

    try {
      return await this.prisma.driver.update({ where: { id }, data });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ConflictException(
          `A driver with license number "${input.licenseNumber ?? ""}" already exists.`,
        );
      }
      throw error;
    }
  }

  /**
   * Hard delete. Acceptable in iter 7 because no Trip aggregate exists
   * yet — once Trips reference Driver by id, hard-deleting a driver
   * who has trips would either orphan the trips (data loss) or fail
   * at the DB layer (foreign-key Restrict → Prisma P2003, which we
   * would then map to HTTP 409 the same way P2002 is mapped today).
   * The decision between "switch to soft-delete" and "block-when-
   * referenced" is deferred until Trips lands and we see the
   * dependency direction in practice. The controller-side comment on
   * `remove()` carries the same plan so a reader of the public
   * surface finds it without opening this file.
   *
   * Returns true on delete, false when the driver was not found, so
   * the controller can shape the 404 response (api-error-mapping
   * runbook entry for P2025).
   */
  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.driver.delete({ where: { id } });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        // P2025 = "An operation failed because it depends on one or
        // more records that were required but not found." Prisma raises
        // this when delete targets a non-existent row.
        error.code === "P2025"
      ) {
        return false;
      }
      throw error;
    }
  }
}
