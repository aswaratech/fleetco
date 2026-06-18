import { Controller, Get, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import type { NotificationLog } from "@prisma/client";

import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { RequirePermission } from "../auth/decorators";
import { RolesGuard } from "../auth/roles.guard";

// NotificationLogsService is injected by NestJS via emitDecoratorMetadata; the
// class reference must remain a value import at runtime so the DI container can
// resolve it. Same pattern every other controller uses for its service.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { NotificationLogsService, LIST_TAKE_DEFAULT } from "./notification-logs.service";
import {
  ListNotificationLogsQuerySchema,
  type ListNotificationLogsQuery,
  type NotificationLogSortColumn,
  type NotificationLogSortDir,
} from "./notification-logs.schemas";

export interface NotificationLogsListResponse {
  items: NotificationLog[];
  total: number;
  skip: number;
  take: number;
  // Echo the effective sort/pagination back so the web client renders the
  // active-column indicator and paginator without re-deriving from the URL —
  // the same wire contract every list response carries.
  sortBy: NotificationLogSortColumn;
  sortDir: NotificationLogSortDir;
}

// NotificationLogs read controller (ADR-0038 C4). Route prefix
// `api/v1/notification-logs`, matching the versioning convention of every other
// controller.
//
// WHY A SIBLING CONTROLLER, NOT ONE ON NotificationModule (ADR-0038 c2):
// NotificationModule deliberately exposes NO HTTP surface — it is a scheduled
// background job, no controller, no AuthModule import. So the read/audit surface
// lives here, in its own module that reads the `notificationLog` table through
// the shared PrismaService (the ReportsModule / RetentionModule precedent).
//
// RBAC (ADR-0028 / ADR-0038): guards are applied at the CONTROLLER level —
// `@UseGuards(AuthGuard, RolesGuard)` in that order, so AuthGuard resolves the
// session first (401 for anonymous) and RolesGuard then enforces the per-route
// `@RequirePermission("notifications:read")` (403 for authenticated-but-
// unauthorized). The capability is ADMIN-ONLY: notification-delivery history is
// operational audit data (who we emailed about which lapse, and when) at the
// observability / users:manage tier, NOT operational data entry the office staff
// touch. The closed Capability union makes a typo'd token a compile error.
//
// READ-ONLY by design: there is NO POST / PATCH / DELETE. The NotificationLog is
// an append-only ledger written ONLY by the scan→send worker; an HTTP client
// must never mutate the audit trail.
@Controller("api/v1/notification-logs")
@UseGuards(AuthGuard, RolesGuard)
export class NotificationLogsController {
  constructor(private readonly notificationLogs: NotificationLogsService) {}

  /**
   * List notification-log rows with filter / sort / pagination. ZodValidationPipe
   * runs ListNotificationLogsQuerySchema over the query: rejects unknown keys
   * (`.strict()`) with 400, normalizes the open-string filters (subjectType /
   * reminderKind / state), coerces the `sentAt` date range, bounds skip / take,
   * and validates `sortBy` against the whitelist. Defaults applied here mirror
   * the service so the echoed values are the ones that actually ran the query.
   */
  @Get()
  @RequirePermission("notifications:read")
  async list(
    @Query(new ZodValidationPipe(ListNotificationLogsQuerySchema))
    query: ListNotificationLogsQuery,
  ): Promise<NotificationLogsListResponse> {
    const skip = query.skip ?? 0;
    const take = query.take ?? LIST_TAKE_DEFAULT;
    const sortBy: NotificationLogSortColumn = query.sortBy ?? "sentAt";
    const sortDir: NotificationLogSortDir = query.sortDir ?? "desc";

    const { items, total } = await this.notificationLogs.list({
      skip,
      take,
      subjectType: query.subjectType,
      reminderKind: query.reminderKind,
      state: query.state,
      startDate: query.startDate,
      endDate: query.endDate,
      sortBy,
      sortDir,
    });
    return { items, total, skip, take, sortBy, sortDir };
  }

  /**
   * Fetch one notification-log row by id. 404 when the row does not exist, with
   * the id named in the message so an operator chasing a bad URL sees exactly
   * which id missed. Mirrors CustomersController.getById.
   */
  @Get(":id")
  @RequirePermission("notifications:read")
  async getById(@Param("id") id: string): Promise<NotificationLog> {
    const row = await this.notificationLogs.findById(id);
    if (!row) {
      throw new NotFoundException(`Notification log ${id} not found`);
    }
    return row;
  }
}
