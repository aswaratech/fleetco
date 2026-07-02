import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, type TrackerStatus } from "@prisma/client";

import type {
  CreateTrackerInput,
  TrackerSortColumn,
  TrackerSortDir,
  UpdateTrackerInput,
} from "./trackers.schemas";
import { validateTrackerLifecycle } from "./trackers.schemas";

// Re-export the schema-inferred input types so call sites (the controller and
// tests) can pull them from this module — the same convention every other
// aggregate service follows.
export type { CreateTrackerInput, UpdateTrackerInput };

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata;
// the class reference must remain a value import at runtime so the DI
// container can resolve it. Same eslint override as every other service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

// Every read returns the tracker WITH its assigned vehicle's registration
// (a two-field select, not the whole Vehicle): the /trackers list and the
// vehicle-detail "Tracker" row both need the registration, and shipping it
// here avoids an N+1 fan-out from the web tier.
const VEHICLE_SELECT = {
  vehicle: { select: { id: true, registrationNumber: true } },
} satisfies Prisma.TrackerDeviceInclude;

export type TrackerWithVehicle = Prisma.TrackerDeviceGetPayload<{
  include: typeof VEHICLE_SELECT;
}>;

export interface ListResult {
  items: TrackerWithVehicle[];
  total: number;
}

// Pagination defaults and bounds — same `LIST_TAKE_` prefix and 200 ceiling
// every list service uses; the clamp in `list` is defense-in-depth behind
// the schema's validation.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Prisma's unique-constraint violation code. TrackerDevice carries TWO
// unique columns — `imei` (one physical device, one row) and `vehicleId`
// (at most one mounted tracker per vehicle) — so the 409 names whichever
// field collided (docs/runbook/api-error-mapping.md, the same translation
// as Drivers' licenseNumber).
const PRISMA_UNIQUE_VIOLATION = "P2002";

// Prisma's FK-constraint violation code. On a tracker write it means a
// stale `vehicleId` (or, defensively, `createdById`) — mapped to 400 like
// the geofences customerId arm.
const PRISMA_FK_VIOLATION = "P2003";

// Prisma's "record required but not found" code (update on a vanished row).
const PRISMA_RECORD_NOT_FOUND = "P2025";

@Injectable()
export class TrackersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List tracker devices with optional status / vehicleId filters, a
   * whitelisted sort, and pagination. `total` reflects the filtered count.
   * Defaults: 20 rows, newest first by createdAt; deterministic secondary
   * tiebreaker — the same shape as every other list service.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    status,
    vehicleId,
    sortBy = "createdAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    status?: TrackerStatus[];
    vehicleId?: string;
    sortBy?: TrackerSortColumn;
    sortDir?: TrackerSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    const where: Prisma.TrackerDeviceWhereInput = {
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
      ...(vehicleId ? { vehicleId } : {}),
    };

    const orderBy: Prisma.TrackerDeviceOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.TrackerDeviceOrderByWithRelationInput,
      ...(sortBy === "createdAt"
        ? [{ id: sortDir } as Prisma.TrackerDeviceOrderByWithRelationInput]
        : [{ createdAt: "desc" } as Prisma.TrackerDeviceOrderByWithRelationInput]),
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.trackerDevice.findMany({
        skip: safeSkip,
        take: safeTake,
        where,
        orderBy,
        include: VEHICLE_SELECT,
      }),
      this.prisma.trackerDevice.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one tracker by id. Returns `null` when not found rather than
   * throwing, so the controller shapes the 404 and other call sites can
   * use the service without exception handling for the not-found path.
   */
  async findById(id: string): Promise<TrackerWithVehicle | null> {
    return this.prisma.trackerDevice.findUnique({ where: { id }, include: VEHICLE_SELECT });
  }

  /**
   * Fetch one tracker by id or throw NotFoundException (HTTP 404), the
   * message echoing the id. Mirror of GeofencesService.getById.
   */
  async getById(id: string): Promise<TrackerWithVehicle> {
    const tracker = await this.findById(id);
    if (!tracker) {
      throw new NotFoundException(`Tracker ${id} not found`);
    }
    return tracker;
  }

  /**
   * Register a tracker device. `createdById` comes from the authenticated
   * session, never the client (the schema's `.strict()` rejects it). The
   * retirement invariant (RETIRED ⇒ unassigned) was enforced by the create
   * schema's superRefine; a duplicate IMEI or an already-tracked vehicle is
   * caught here as Prisma P2002 → 409 naming the field, and a
   * stale-but-cuid-shaped vehicleId as P2003 → 400.
   */
  async create(input: CreateTrackerInput, createdById: string): Promise<TrackerWithVehicle> {
    const data: Prisma.TrackerDeviceUncheckedCreateInput = {
      imei: input.imei,
      label: input.label ?? null,
      simMsisdn: input.simMsisdn ?? null,
      ...(input.status !== undefined && { status: input.status }),
      vehicleId: input.vehicleId ?? null,
      installedAt: input.installedAt ?? null,
      createdById,
    };

    try {
      return await this.prisma.trackerDevice.create({ data, include: VEHICLE_SELECT });
    } catch (error) {
      throw mapTrackerWriteError(error, input.imei, input.vehicleId ?? null);
    }
  }

  /**
   * Diff-PATCH a tracker. Returns null when the row is not found (controller
   * maps to 404), mirroring GeofencesService.update.
   *
   *   1. Fetch the existing row (null → controller 404).
   *   2. Re-run the retirement invariant against the MERGED shape: a PATCH
   *      that changes only `status` re-validates against the stored
   *      vehicleId, and one that changes only `vehicleId` against the
   *      stored status.
   *   3. `installedAt` reset rule (the schema comment's "reset on
   *      reassignment"): when the PATCH changes `vehicleId` (assign,
   *      reassign, or unassign) WITHOUT supplying `installedAt`, the stored
   *      date is cleared — it described the mount on the PREVIOUS vehicle
   *      and keeping it would be a plausible lie. A PATCH that supplies
   *      both wins as written.
   *   4. Prisma writes only the touched fields. P2025 → null (404);
   *      P2002 → 409 naming the collided field; P2003 → 400.
   */
  async update(id: string, input: UpdateTrackerInput): Promise<TrackerWithVehicle | null> {
    const existing = await this.prisma.trackerDevice.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }

    const has = (key: keyof UpdateTrackerInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    const mergedStatus = input.status ?? existing.status;
    const mergedVehicleId = has("vehicleId") ? (input.vehicleId ?? null) : existing.vehicleId;
    const lifecycleErrors = validateTrackerLifecycle({
      status: mergedStatus,
      vehicleId: mergedVehicleId,
    });
    if (lifecycleErrors.length > 0) {
      throw new BadRequestException(lifecycleErrors.join(" "));
    }

    const vehicleChanged = has("vehicleId") && (input.vehicleId ?? null) !== existing.vehicleId;

    const data: Prisma.TrackerDeviceUncheckedUpdateInput = {
      ...(input.imei !== undefined && { imei: input.imei }),
      ...(has("label") && { label: input.label ?? null }),
      ...(has("simMsisdn") && { simMsisdn: input.simMsisdn ?? null }),
      ...(input.status !== undefined && { status: input.status }),
      ...(has("vehicleId") && { vehicleId: input.vehicleId ?? null }),
      ...(has("installedAt")
        ? { installedAt: input.installedAt ?? null }
        : vehicleChanged && { installedAt: null }),
    };

    try {
      return await this.prisma.trackerDevice.update({
        where: { id },
        data,
        include: VEHICLE_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_RECORD_NOT_FOUND
      ) {
        // Row vanished between the findUnique and the update.
        return null;
      }
      throw mapTrackerWriteError(error, input.imei ?? existing.imei, mergedVehicleId);
    }
  }

  // NOTE: there is deliberately NO delete method. ADR-0042 c6 defines no
  // delete for the tracker register — a physical device that existed keeps
  // its row; unassign frees the vehicle slot and RETIRED ends the lifecycle.
}

// Translate a Prisma write error into the HTTP-facing exception, naming the
// field that collided (docs/runbook/api-error-mapping.md):
//
//   - P2002 on `imei`      → 409 "A tracker with IMEI … already exists."
//   - P2002 on `vehicleId` → 409 "Vehicle … already has a tracker assigned."
//     (the one-mounted-tracker-per-vehicle slot, ADR-0042 c6)
//   - P2003 on `createdBy` → 400 "sign in again" (defense-in-depth)
//   - P2003 otherwise      → 400 "Vehicle … does not exist." (the only
//     client-controlled FK)
//
// Non-mapped errors pass through unchanged (Nest renders them as 500).
function mapTrackerWriteError(error: unknown, imei: string, vehicleId: string | null): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return error;
  }
  if (error.code === PRISMA_UNIQUE_VIOLATION) {
    const meta = error.meta as { target?: string[] | string } | undefined;
    const target = Array.isArray(meta?.target) ? meta.target.join(",") : String(meta?.target ?? "");
    if (target.toLowerCase().includes("vehicle")) {
      return new ConflictException(
        `Vehicle ${vehicleId ?? ""} already has a tracker assigned. Unassign it first.`,
      );
    }
    return new ConflictException(`A tracker with IMEI "${imei}" already exists.`);
  }
  if (error.code === PRISMA_FK_VIOLATION) {
    const meta = error.meta as { field_name?: string; constraint?: string } | undefined;
    const fieldName = String(meta?.field_name ?? meta?.constraint ?? "");
    if (fieldName.toLowerCase().includes("createdby")) {
      return new BadRequestException("Authenticated user no longer exists; sign in again.");
    }
    return new BadRequestException(`Vehicle ${vehicleId ?? ""} does not exist.`);
  }
  return error;
}
