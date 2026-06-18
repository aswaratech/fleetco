import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type ServiceRecord } from "@prisma/client";

import type {
  CreateServiceRecordInput,
  ServiceRecordSortColumn,
  ServiceRecordSortDir,
  UpdateServiceRecordInput,
} from "./service-records.schemas";

// Re-export the schema-inferred input types so call sites can pull them from
// this module — the convention every aggregate service follows.
export type { CreateServiceRecordInput, UpdateServiceRecordInput };

// PrismaService is injected by NestJS via emitDecoratorMetadata; the class
// reference must remain a value import at runtime. Same eslint override as
// every other vertical-slice service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: ServiceRecord[];
  total: number;
}

// Pagination defaults and bounds — same `LIST_TAKE_` prefix and 200 ceiling
// every Phase-1 list service uses. The clamp in `list` is defense-in-depth.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// Prisma error codes. ServiceRecord has no unique constraint, so no P2002.
// P2003 (FK violation) on a write means a stale vehicleId / serviceScheduleId /
// expenseLogId / createdById → HTTP 400. P2025 (record not found) on
// update/delete → 404. Nothing FKs INTO ServiceRecord (the ExpenseLog cost-link
// points OUT of it — the Restrict is enforced on ExpenseLog's delete, not
// here), so there is no delete-when-referenced 409 arm in this service.
const PRISMA_FK_VIOLATION = "P2003";
const PRISMA_RECORD_NOT_FOUND = "P2025";

@Injectable()
export class ServiceRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List service records with optional vehicleId / serviceScheduleId filters, a
   * whitelisted sort, and pagination. `total` reflects the filtered count.
   *
   * Default sort is performedAt desc ("most recent service first"). The `id`
   * secondary tiebreaker (when the primary is unique-enough) keeps pagination
   * deterministic. `skip` / `take` are clamped to safe bounds as
   * defense-in-depth even though the controller already validated them.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    vehicleId,
    serviceScheduleId,
    sortBy = "performedAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    vehicleId?: string;
    serviceScheduleId?: string;
    sortBy?: ServiceRecordSortColumn;
    sortDir?: ServiceRecordSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    const where: Prisma.ServiceRecordWhereInput = {
      ...(vehicleId ? { vehicleId } : {}),
      ...(serviceScheduleId ? { serviceScheduleId } : {}),
    };

    // Primary sort + a stable secondary tiebreaker. performedAt can repeat
    // (two services the same day), so the `id` tiebreaker is always added for
    // determinism; when sorting by createdAt the id mirrors the direction.
    const orderBy: Prisma.ServiceRecordOrderByWithRelationInput[] = [
      { [sortBy]: sortDir } as Prisma.ServiceRecordOrderByWithRelationInput,
      { id: sortDir } as Prisma.ServiceRecordOrderByWithRelationInput,
    ];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.serviceRecord.findMany({ skip: safeSkip, take: safeTake, where, orderBy }),
      this.prisma.serviceRecord.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one record by id. Returns `null` when not found rather than throwing,
   * so the controller shapes the 404 and the service stays usable from other
   * modules without exception handling for the not-found path.
   */
  async findById(id: string): Promise<ServiceRecord | null> {
    return this.prisma.serviceRecord.findUnique({ where: { id } });
  }

  /**
   * Create a ServiceRecord. `createdById` is supplied by the controller from
   * the authenticated session, never the client (the schema's `.strict()`
   * rejects it).
   *
   * Schedule↔vehicle consistency (ADR-0037 c5/c6 rotation of the fuel-logs
   * trip-vehicle check): when `serviceScheduleId` is set, the referenced
   * schedule must belong to the same vehicle as the record — recording truck
   * Y's schedule against excavator X's service is nonsensical. A missing
   * schedule is a clean 400 (pre-empting the FK's P2003); a vehicle mismatch is
   * a clean 400. A stale vehicleId still falls through to the FK (P2003 → 400).
   */
  async create(input: CreateServiceRecordInput, createdById: string): Promise<ServiceRecord> {
    if (input.serviceScheduleId) {
      await this.assertScheduleBelongsToVehicle(input.serviceScheduleId, input.vehicleId);
    }
    if (input.expenseLogId) {
      await this.assertExpenseLogLinkable(input.expenseLogId, input.vehicleId);
    }

    const data: Prisma.ServiceRecordUncheckedCreateInput = {
      vehicleId: input.vehicleId,
      serviceScheduleId: input.serviceScheduleId ?? null,
      expenseLogId: input.expenseLogId ?? null,
      performedAt: input.performedAt,
      odometerKm: input.odometerKm ?? null,
      engineHours: input.engineHours ?? null,
      notes: input.notes ?? null,
      createdById,
    };

    try {
      // Anchor-advance (ADR-0037 c5), ATOMIC with the insert: when a service is
      // recorded against a schedule, advance that schedule's last-service anchor
      // forward in the SAME interactive $transaction as the record insert — the
      // exact shape of the Trip→Vehicle odometer bump (iter 11), so a mid-flight
      // failure can never leave a recorded service with a stale schedule anchor.
      // An ad-hoc record (no schedule) is a plain insert. Recording is a CREATE
      // event: a later PATCH does NOT re-advance the anchor (the documented
      // manual-correction path — edit the schedule's anchor or the record — is
      // the compensating action), mirroring the odometer-correction story.
      return await this.prisma.$transaction(async (tx) => {
        const record = await tx.serviceRecord.create({ data });
        if (record.serviceScheduleId !== null) {
          await this.advanceScheduleAnchor(tx, record);
        }
        return record;
      });
    } catch (error) {
      throw mapRecordWriteError(
        error,
        input.vehicleId,
        input.serviceScheduleId ?? null,
        input.expenseLogId ?? null,
      );
    }
  }

  /**
   * Diff-PATCH a ServiceRecord. Returns null when the row is not found
   * (controller maps to 404). vehicleId is immutable (omitted from the schema).
   * `serviceScheduleId` and `expenseLogId` are mutable: re-linking either
   * re-runs its consistency check against the STORED vehicleId (the schedule
   * must be on the same vehicle; the expense must be a same-vehicle
   * MAINTENANCE/REPAIR row). The service distinguishes "client provided null"
   * (unlink) from "client did not mention" (leave it) via hasOwnProperty.
   *
   * PATCH does NOT advance the schedule anchor — the anchor-advance is a
   * recording (create) event (ADR-0037 c5); editing a recorded service is the
   * manual-correction path, so it leaves the anchor where the original
   * recording left it.
   */
  async update(id: string, input: UpdateServiceRecordInput): Promise<ServiceRecord | null> {
    const existing = await this.prisma.serviceRecord.findUnique({ where: { id } });
    if (!existing) {
      return null;
    }

    const has = (key: keyof UpdateServiceRecordInput): boolean =>
      Object.prototype.hasOwnProperty.call(input, key);

    // Re-link to a (non-null) schedule / expense re-validates against the
    // record's immutable stored vehicleId.
    if (input.serviceScheduleId) {
      await this.assertScheduleBelongsToVehicle(input.serviceScheduleId, existing.vehicleId);
    }
    if (input.expenseLogId) {
      await this.assertExpenseLogLinkable(input.expenseLogId, existing.vehicleId);
    }

    const data: Prisma.ServiceRecordUncheckedUpdateInput = {
      ...(has("serviceScheduleId") && { serviceScheduleId: input.serviceScheduleId ?? null }),
      ...(has("expenseLogId") && { expenseLogId: input.expenseLogId ?? null }),
      ...(input.performedAt !== undefined && { performedAt: input.performedAt }),
      ...(has("odometerKm") && { odometerKm: input.odometerKm ?? null }),
      ...(has("engineHours") && { engineHours: input.engineHours ?? null }),
      ...(has("notes") && { notes: input.notes ?? null }),
    };

    try {
      return await this.prisma.serviceRecord.update({ where: { id }, data });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_RECORD_NOT_FOUND
      ) {
        // Row vanished between the findUnique and the update (concurrent delete).
        return null;
      }
      throw mapRecordWriteError(
        error,
        existing.vehicleId,
        input.serviceScheduleId ?? null,
        input.expenseLogId ?? null,
      );
    }
  }

  /**
   * Hard delete. Returns true on delete, false when the record was not found
   * (P2025), so the controller shapes the 404. No P2003 arm — nothing FKs INTO
   * ServiceRecord (the B4 ExpenseLog cost-link points the other way).
   */
  async delete(id: string): Promise<boolean> {
    try {
      await this.prisma.serviceRecord.delete({ where: { id } });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_RECORD_NOT_FOUND
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Fetch one record by id or throw NotFoundException (HTTP 404). Convenience
   * wrapper for the controller's GET /:id handler; the message echoes the id.
   */
  async getById(id: string): Promise<ServiceRecord> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException(`Service record ${id} not found`);
    }
    return record;
  }

  /**
   * Assert the referenced schedule exists and belongs to the same vehicle as
   * the record (ADR-0037 c5). A missing schedule → 400 (clean, pre-empts the
   * FK's P2003); a vehicle mismatch → 400. Rotation of the fuel-logs
   * trip-vehicle consistency check.
   */
  private async assertScheduleBelongsToVehicle(
    serviceScheduleId: string,
    vehicleId: string,
  ): Promise<void> {
    const schedule = await this.prisma.serviceSchedule.findUnique({
      where: { id: serviceScheduleId },
      select: { vehicleId: true },
    });
    if (!schedule) {
      throw new BadRequestException(`Service schedule ${serviceScheduleId} does not exist.`);
    }
    if (schedule.vehicleId !== vehicleId) {
      throw new BadRequestException(
        `Service schedule ${serviceScheduleId} belongs to a different vehicle; ` +
          "a service record must reference a schedule on the same vehicle.",
      );
    }
  }

  /**
   * Assert the referenced ExpenseLog exists, is a MAINTENANCE or REPAIR row, and
   * is on the same vehicle as the record (ADR-0037 c6 — the cost-link
   * consistency check, the rotation of the fuel/expense trip-vehicle check). A
   * missing expense → 400 (clean, pre-empts the FK's P2003); a non-maintenance
   * category → 400; a vehicle mismatch (including a vehicle-agnostic
   * null-vehicle expense) → 400. The cost lives in exactly one place — the
   * ExpenseLog row — and the link must point at the RIGHT one.
   */
  private async assertExpenseLogLinkable(expenseLogId: string, vehicleId: string): Promise<void> {
    const expense = await this.prisma.expenseLog.findUnique({
      where: { id: expenseLogId },
      select: { category: true, vehicleId: true },
    });
    if (!expense) {
      throw new BadRequestException(`Expense log ${expenseLogId} does not exist.`);
    }
    if (expense.category !== "MAINTENANCE" && expense.category !== "REPAIR") {
      throw new BadRequestException(
        `Expense log ${expenseLogId} is category ${expense.category}; a service record can only ` +
          "link a MAINTENANCE or REPAIR expense.",
      );
    }
    if (expense.vehicleId !== vehicleId) {
      throw new BadRequestException(
        `Expense log ${expenseLogId} is not attributed to this vehicle; a service record must ` +
          "reference an expense on the same vehicle.",
      );
    }
  }

  /**
   * Advance the linked schedule's last-service anchor to the record's values,
   * inside the caller's interactive $transaction (ADR-0037 c5). The monotonic
   * "once forward, stays forward" rule, the rotation of the Trip→Vehicle
   * odometer bump (iter 11):
   *   - lastServiceAt takes the recorded performedAt, but only when it moves
   *     FORWARD (a backdated correction record must not roll the calendar anchor
   *     back) — so "next due" for a CALENDAR schedule resets forward.
   *   - the meter anchors (odometer / engine-hours) advance only when the
   *     record's reading is strictly greater than the stored anchor; a null
   *     stored anchor is "behind any reading", so the first record seeds it.
   * Recording a service therefore resets "next due" forward by one interval.
   * Issues at most one UPDATE (skipped entirely when nothing moves forward — a
   * pure backdated correction). `tx` is the transaction client so this write and
   * the record insert commit together.
   */
  private async advanceScheduleAnchor(
    tx: Prisma.TransactionClient,
    record: ServiceRecord,
  ): Promise<void> {
    if (record.serviceScheduleId === null) return; // defensive — the caller guards
    const schedule = await tx.serviceSchedule.findUniqueOrThrow({
      where: { id: record.serviceScheduleId },
      select: { lastServiceAt: true, lastServiceOdometerKm: true, lastServiceEngineHours: true },
    });

    const patch: Prisma.ServiceScheduleUncheckedUpdateInput = {};
    if (record.performedAt > schedule.lastServiceAt) {
      patch.lastServiceAt = record.performedAt;
    }
    if (
      record.odometerKm !== null &&
      (schedule.lastServiceOdometerKm === null ||
        record.odometerKm > schedule.lastServiceOdometerKm)
    ) {
      patch.lastServiceOdometerKm = record.odometerKm;
    }
    if (
      record.engineHours !== null &&
      (schedule.lastServiceEngineHours === null ||
        record.engineHours > schedule.lastServiceEngineHours)
    ) {
      patch.lastServiceEngineHours = record.engineHours;
    }

    if (Object.keys(patch).length > 0) {
      await tx.serviceSchedule.update({ where: { id: record.serviceScheduleId }, data: patch });
    }
  }
}

// Translate a Prisma write error into the HTTP-facing exception. A P2003 on a
// ServiceRecord write is a stale FK: name the offending field in the 400 per
// docs/runbook/api-error-mapping.md (the web actions layer pattern-matches the
// message to set the field token). serviceScheduleId and expenseLogId are
// pre-checked in the service, so in practice P2003 names vehicleId (or,
// defensively, createdById / a schedule or expense deleted between the
// pre-check and the write). Non-P2003 errors pass through unchanged (Nest
// renders them as 500).
function mapRecordWriteError(
  error: unknown,
  vehicleId: string,
  serviceScheduleId: string | null,
  expenseLogId: string | null,
): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === PRISMA_FK_VIOLATION) {
    const meta = error.meta as { field_name?: string; constraint?: string } | undefined;
    const fieldName = String(meta?.field_name ?? meta?.constraint ?? "").toLowerCase();
    if (fieldName.includes("createdby")) {
      return new BadRequestException("Authenticated user no longer exists; sign in again.");
    }
    if (fieldName.includes("serviceschedule") && serviceScheduleId) {
      return new BadRequestException(`Service schedule ${serviceScheduleId} does not exist.`);
    }
    if (fieldName.includes("expenselog") && expenseLogId) {
      return new BadRequestException(`Expense log ${expenseLogId} does not exist.`);
    }
    return new BadRequestException(`Vehicle ${vehicleId} does not exist.`);
  }
  return error;
}
