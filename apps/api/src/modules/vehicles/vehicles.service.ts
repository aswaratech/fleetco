import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma, type Vehicle, VehicleStatus } from "@prisma/client";

import type { CreateVehicleInput, UpdateVehicleInput } from "./vehicles.schemas";

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value
// import at runtime so the DI container can resolve it.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: Vehicle[];
  total: number;
}

// Pagination defaults and bounds. The take cap (200) protects the API
// from accidentally large queries while leaving plenty of headroom for
// the admin UI's 50 / 100 page sizes documented in DESIGN.md's Tables
// section. The minimum take (1) prevents the degenerate request that
// returns count-only information through this endpoint; consumers that
// want just a count can read `total` after a default take.
export const DEFAULT_TAKE = 20;
export const MAX_TAKE = 200;
const MIN_TAKE = 1;

// Prisma's unique-constraint violation code. Surface as HTTP 409 rather
// than 500 so the client can render a clear inline message. Centralized
// here so future write methods reuse the same translation. See
// docs/runbook/api-error-mapping.md for the project-wide convention.
const PRISMA_UNIQUE_VIOLATION = "P2002";

function isPrismaUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_UNIQUE_VIOLATION
  );
}

// Statuses that mean "out of fleet". Transitioning into one of these
// auto-populates retiredAt; transitioning back to ACTIVE/IN_MAINTENANCE
// clears it. The kickoff calls this the "retirement transition" rule.
const OUT_OF_FLEET_STATUSES = new Set<VehicleStatus>([VehicleStatus.RETIRED, VehicleStatus.SOLD]);

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List vehicles ordered by acquisition date descending (newest first).
   * `skip` and `take` follow Prisma's semantics; both are clamped to safe
   * bounds so a malformed query cannot scan the whole table or return
   * zero rows for non-zero takes. Returns `{ items, total }` so the UI
   * can render pagination without a second round-trip.
   */
  async list({
    skip = 0,
    take = DEFAULT_TAKE,
  }: {
    skip?: number;
    take?: number;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : DEFAULT_TAKE;
    const safeTake = Math.min(Math.max(safeTakeRaw, MIN_TAKE), MAX_TAKE);

    const args: Prisma.VehicleFindManyArgs = {
      skip: safeSkip,
      take: safeTake,
      orderBy: [{ acquiredAt: "desc" }, { createdAt: "desc" }],
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.vehicle.findMany(args),
      this.prisma.vehicle.count(),
    ]);

    return { items, total };
  }

  /**
   * Fetch one vehicle by id. Returns `null` when not found rather than
   * throwing, so the controller can shape the 404 response and the
   * service stays usable from other modules without exception handling
   * for the not-found path.
   */
  async getById(id: string): Promise<Vehicle | null> {
    return this.prisma.vehicle.findUnique({ where: { id } });
  }

  /**
   * Create a Vehicle. `createdById` is supplied by the controller from
   * the authenticated session, not by the client (the create schema in
   * vehicles.schemas.ts rejects unknown keys via `.strict()`, so a
   * client cannot inject a createdById through the body either).
   * `odometerCurrentKm` defaults to `odometerStartKm` when absent,
   * matching the kickoff rule that "current at acquisition equals
   * start"; encoding this in the service rather than the schema avoids
   * leaking the dependency between two fields into the validation file.
   * Throws ConflictException (HTTP 409) on unique-constraint violation
   * of registrationNumber; everything else propagates and Nest's
   * default exception filter renders 500.
   */
  async create(input: CreateVehicleInput, createdById: string): Promise<Vehicle> {
    const startKm = input.odometerStartKm ?? 0;
    const data: Prisma.VehicleUncheckedCreateInput = {
      registrationNumber: input.registrationNumber,
      kind: input.kind,
      make: input.make,
      model: input.model,
      year: input.year,
      status: input.status ?? VehicleStatus.ACTIVE,
      odometerStartKm: startKm,
      odometerCurrentKm: input.odometerCurrentKm ?? startKm,
      acquiredAt: input.acquiredAt,
      createdById,
    };

    try {
      return await this.prisma.vehicle.create({ data });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ConflictException(
          `A vehicle with registration number "${input.registrationNumber}" already exists.`,
        );
      }
      throw error;
    }
  }

  /**
   * Partial update. The controller's validation guarantees the body is
   * non-empty and contains only mutable fields (id and createdById are
   * not present in UpdateVehicleSchema and unknown keys are rejected).
   * The retirement-transition rule is applied here rather than in the
   * controller because it touches two fields and is genuinely a
   * service-layer policy: a status change implies a retiredAt change
   * unless the client overrides explicitly.
   *
   *   - Transition INTO {RETIRED, SOLD}: set retiredAt to the client's
   *     value if provided, otherwise to `new Date()`.
   *   - Transition OUT of {RETIRED, SOLD} back to ACTIVE/IN_MAINTENANCE:
   *     clear retiredAt unless the client has explicitly provided one
   *     (an unusual but legitimate case — e.g., correcting a historical
   *     record where the vehicle was sold and bought back).
   *   - No status change: respect retiredAt only if the client passed
   *     it explicitly; otherwise leave the stored value alone.
   *
   * Returns null when the vehicle is not found, mirroring getById's
   * shape so the controller can shape the 404 response.
   */
  async update(id: string, input: UpdateVehicleInput): Promise<Vehicle | null> {
    const existing = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }

    // Compute retiredAt patch based on the retirement-transition rule.
    // The client's explicit value (including null) always wins; only
    // when the client did NOT mention retiredAt do we derive it from
    // the status transition.
    const clientProvidedRetiredAt = Object.prototype.hasOwnProperty.call(input, "retiredAt");
    let derivedRetiredAt: Date | null | undefined;
    if (!clientProvidedRetiredAt && input.status !== undefined) {
      const transitioningIntoOutOfFleet =
        OUT_OF_FLEET_STATUSES.has(input.status) && !OUT_OF_FLEET_STATUSES.has(existing.status);
      const transitioningOutOfOutOfFleet =
        !OUT_OF_FLEET_STATUSES.has(input.status) && OUT_OF_FLEET_STATUSES.has(existing.status);
      if (transitioningIntoOutOfFleet) {
        derivedRetiredAt = new Date();
      } else if (transitioningOutOfOutOfFleet) {
        derivedRetiredAt = null;
      }
    }

    const data: Prisma.VehicleUpdateInput = {
      ...(input.registrationNumber !== undefined && {
        registrationNumber: input.registrationNumber,
      }),
      ...(input.kind !== undefined && { kind: input.kind }),
      ...(input.make !== undefined && { make: input.make }),
      ...(input.model !== undefined && { model: input.model }),
      ...(input.year !== undefined && { year: input.year }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.odometerStartKm !== undefined && { odometerStartKm: input.odometerStartKm }),
      ...(input.odometerCurrentKm !== undefined && {
        odometerCurrentKm: input.odometerCurrentKm,
      }),
      ...(input.acquiredAt !== undefined && { acquiredAt: input.acquiredAt }),
      ...(clientProvidedRetiredAt
        ? { retiredAt: input.retiredAt ?? null }
        : derivedRetiredAt !== undefined && { retiredAt: derivedRetiredAt }),
    };

    try {
      return await this.prisma.vehicle.update({ where: { id }, data });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        throw new ConflictException(
          `A vehicle with registration number "${input.registrationNumber ?? ""}" already exists.`,
        );
      }
      throw error;
    }
  }

  /**
   * Hard delete. Acceptable in iter 2 because no Trip aggregate exists
   * yet (ADR-0003's onDelete: Restrict applies to createdBy → User, not
   * Vehicle → its dependants). Returns true on delete, false when the
   * vehicle was not found, so the controller can shape the 404 response.
   *
   * A future slice (Trips) will likely change this method: either to a
   * soft delete (add `deletedAt` to the schema and filter on read) or
   * to a block-when-referenced check that throws ConflictException if
   * any Trip references this Vehicle. The decision is deferred until
   * Trips lands and we know the dependency direction in practice.
   */
  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.vehicle.delete({ where: { id } });
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
