import { Injectable } from "@nestjs/common";
// Type-only: this read service touches no Prisma value (no error-class instanceof
// checks — it never writes), only the generated query/where/orderBy TYPES.
import type { Prisma, NotificationLog } from "@prisma/client";

import type {
  NotificationLogSortColumn,
  NotificationLogSortDir,
} from "./notification-logs.schemas";

// PrismaService is injected by NestJS via TypeScript's emitDecoratorMetadata
// (see apps/api/tsconfig.json); the class reference must remain a value import
// at runtime so the DI container can resolve it. Same eslint override as every
// other vertical-slice service that injects PrismaService.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../prisma/prisma.service";

export interface ListResult {
  items: NotificationLog[];
  total: number;
}

// Pagination defaults and bounds. Names match the customers / geofences
// services so the surfaces stay grep-symmetric. The take cap (200) matches
// every other list surface; the minimum take (1) prevents the degenerate
// count-only request through this endpoint. LIST_TAKE_MAX is defense-in-depth:
// the controller validates `take` against the same ceiling via the query
// schema, but a clamp here keeps the database from ever being asked for an
// unbounded result regardless of how a future internal caller reaches the
// service.
export const LIST_TAKE_DEFAULT = 20;
export const LIST_TAKE_MAX = 200;
const LIST_TAKE_MIN = 1;

// NotificationLogsService — the READ side of the notification/reminder-delivery
// ledger (ADR-0038 C4). It is a SIBLING of NotificationModule, NOT part of it:
// ADR-0038 commitment 2 fixes that NotificationModule exposes NO HTTP surface
// (it is a scheduled background job), so the read/audit concern lives in its own
// module that reads the `notificationLog` table through the shared
// PrismaService — the same in-repo precedent ReportsModule / RetentionModule set
// (querying another aggregate's table via the shared infrastructure service is
// NOT a cross-module-internals breach, ADR-0001).
//
// There is NO create / update / delete here: the NotificationLog is an
// append-only ledger written ONLY by the scan→send worker (NotificationService).
// This service reads it back for the operator's audit history.
@Injectable()
export class NotificationLogsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List notification-log rows. Supports exact-match filtering by subjectType /
   * reminderKind / state (open strings per the forward-compat rule), an
   * inclusive `sentAt` date range, sorting by a whitelisted column, and
   * pagination. `total` reflects the filtered count so the UI can render correct
   * "Showing M–N of T" copy and disable next-page at the edge.
   *
   * Defaults (when the caller passes no overrides): 20 rows, most-recently-SENT
   * first (`sentAt` desc) per ADR-0038 C4. Because `sentAt` is nullable
   * (null between a scan-time intent and the send completion — the ADR's
   * eventual write-at-intent design; today rows are written at send-success so
   * sentAt is populated), the desc ordering puts any null-sentAt rows LAST
   * (`nulls: "last"`) so an as-yet-unsent intent never jumps to the top of the
   * "what we sent" history. A `createdAt` then `id` secondary tiebreaker keeps
   * paginated results deterministic (two rows sent in the same scan share a
   * sentAt instant; without the tiebreaker they could flip between page loads
   * and duplicate or skip a row).
   *
   * `skip` / `take` are clamped to safe bounds (LIST_TAKE_MAX = 200) as
   * defense-in-depth.
   */
  async list({
    skip = 0,
    take = LIST_TAKE_DEFAULT,
    subjectType,
    reminderKind,
    state,
    startDate,
    endDate,
    sortBy = "sentAt",
    sortDir = "desc",
  }: {
    skip?: number;
    take?: number;
    subjectType?: string;
    reminderKind?: string;
    state?: string;
    startDate?: Date;
    endDate?: Date;
    sortBy?: NotificationLogSortColumn;
    sortDir?: NotificationLogSortDir;
  }): Promise<ListResult> {
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.floor(skip) : 0;
    const safeTakeRaw = Number.isFinite(take) ? Math.floor(take) : LIST_TAKE_DEFAULT;
    const safeTake = Math.min(Math.max(safeTakeRaw, LIST_TAKE_MIN), LIST_TAKE_MAX);

    // Build the `sentAt` range once. startDate is applied as `gte` (a date-only
    // value is midnight UTC, so the whole start day is included); endDate is made
    // inclusive-THROUGH-end-of-day by advancing it to the start of the next UTC
    // day and using `lt`, so `?endDate=2026-06-19` includes everything sent on
    // the 19th rather than excluding all but the 00:00:00 instant. A null-sentAt
    // row never matches a gte/lt filter (SQL null comparison), which is correct —
    // an unsent intent has no send date to filter on.
    const sentAtFilter: Prisma.DateTimeNullableFilter = {};
    if (startDate !== undefined) sentAtFilter.gte = startDate;
    if (endDate !== undefined) sentAtFilter.lt = startOfNextUtcDay(endDate);

    const where: Prisma.NotificationLogWhereInput = {
      ...(subjectType !== undefined ? { subjectType } : {}),
      ...(reminderKind !== undefined ? { reminderKind } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(Object.keys(sentAtFilter).length > 0 ? { sentAt: sentAtFilter } : {}),
    };

    const orderBy: Prisma.NotificationLogOrderByWithRelationInput[] =
      sortBy === "sentAt"
        ? [
            // Nullable column: keep unsent intents at the bottom of the
            // "what we sent" history regardless of direction.
            { sentAt: { sort: sortDir, nulls: "last" } },
            { createdAt: "desc" },
            { id: "desc" },
          ]
        : [{ createdAt: sortDir }, { id: sortDir }];

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationLog.findMany({ skip: safeSkip, take: safeTake, where, orderBy }),
      this.prisma.notificationLog.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * Fetch one notification-log row by id. Returns `null` when not found rather
   * than throwing, so the controller shapes the 404 response and the service
   * stays usable from other callers without exception handling for the
   * not-found path. Mirror of CustomersService.findById.
   */
  async findById(id: string): Promise<NotificationLog | null> {
    return this.prisma.notificationLog.findUnique({ where: { id } });
  }
}

// Advance a Date to 00:00:00.000 of the NEXT UTC calendar day. Used to make a
// date-only `endDate` filter inclusive through the end of that day. UTC
// accessors (not local) so the boundary is deterministic regardless of server
// timezone — the same UTC-calendar-day discipline the compliance classifier and
// the BS formatter use.
function startOfNextUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0),
  );
}
