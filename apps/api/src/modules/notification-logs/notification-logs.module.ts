import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { NotificationLogsController } from "./notification-logs.controller";
import { NotificationLogsService } from "./notification-logs.service";

// NotificationLogsModule — the READ/audit surface for the reminder-delivery
// ledger (ADR-0038 C4). It is the HTTP-facing SIBLING of NotificationModule:
// ADR-0038 commitment 2 fixes that NotificationModule exposes NO HTTP surface
// (no controller, no AuthModule import — it is a scheduled background job), so
// the read surface lives in its own module that reads the `notificationLog`
// table through the shared global PrismaService. Querying another concern's
// table via the shared infrastructure service is the in-repo ReportsModule /
// RetentionModule precedent (NOT a cross-module-internals breach, ADR-0001).
//
// AuthModule is imported (not just the guards listed in providers) so the AUTH
// provider, AuthGuard, AND RolesGuard are available to the controller's composed
// `@UseGuards(AuthGuard, RolesGuard)` chain at request time — see AuthModule's
// exports ([AUTH, AuthGuard, RolesGuard, …]) and ADR-0021 §6 / ADR-0028 c5. The
// read capability (notifications:read, ADMIN-only) lives in permissions.ts; the
// controller gates each route with @RequirePermission.
//
// NotificationLogsService is exported for symmetry with the other read modules
// (a future surface — e.g. a dashboard "recent reminders" card — can read the
// ledger without a circular import through the controller). PrismaService is
// @Global, so it needs no import here.
@Module({
  imports: [AuthModule],
  controllers: [NotificationLogsController],
  providers: [NotificationLogsService],
  exports: [NotificationLogsService],
})
export class NotificationLogsModule {}
