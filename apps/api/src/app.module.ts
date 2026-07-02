import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";

import { enrichLogWithAvailabilitySignal } from "./common/sli";
import { env } from "./config/env";
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS } from "./observability/log-redact";
import { otelTraceMixin } from "./observability/otel";
import { AuthModule } from "./modules/auth/auth.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { DriversModule } from "./modules/drivers/drivers.module";
import { ExpenseLogsModule } from "./modules/expense-logs/expense-logs.module";
import { FuelLogsModule } from "./modules/fuel-logs/fuel-logs.module";
import { GeofencesModule } from "./modules/geofences/geofences.module";
import { HealthModule } from "./modules/health/health.module";
import { InvoicesModule } from "./modules/invoices/invoices.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { MaintenanceModule } from "./modules/maintenance/maintenance.module";
import { NotificationLogsModule } from "./modules/notification-logs/notification-logs.module";
import { NotificationModule } from "./modules/notifications/notification.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { QueueModule } from "./modules/queue/queue.module";
import { RedisModule } from "./modules/redis/redis.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { RetentionModule } from "./modules/retention/retention.module";
import { TelematicsModule } from "./modules/telematics/telematics.module";
import { TripsModule } from "./modules/trips/trips.module";
import { VehiclesModule } from "./modules/vehicles/vehicles.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: (req, res) => {
          const headerValue = req.headers["x-request-id"];
          const incoming =
            typeof headerValue === "string" && headerValue.length > 0 ? headerValue : undefined;
          const id = incoming ?? randomUUID();
          res.setHeader("x-request-id", id);
          return id;
        },
        // Correlate every log line with the active OpenTelemetry trace
        // (ADR-0024 commitment 5): injects trace_id / span_id when a valid
        // span is active, {} otherwise. Complements genReqId's per-process
        // request id; it does not replace it.
        mixin: otelTraceMixin,
        // API-availability SLI signal (ADR-0011, T_SLI1). Emitted at the
        // pino-http completion-object layer — not a Nest interceptor — so it
        // sees 100% of requests, including the raw better-auth handler at
        // /auth/* that an interceptor would never reach. pino-http logs 5xx
        // (and thrown errors) via a SEPARATE error path, so both the success
        // hook (2xx/3xx/4xx) and the error hook (5xx) delegate to the one
        // enricher; both REPLACE the completion object, hence the spread inside
        // enrichLogWithAvailabilitySignal. Latency is read from pino-http's own
        // `responseTime` (on `val`) so response_time_ms and sli_good never
        // drift from the logged value. The signal is Tier-4 only (status,
        // duration, boolean) per ADR-0013 — it deliberately omits req.url,
        // which the redact list below does not cover and which can carry
        // Tier-2 PII in a query string.
        customSuccessObject: (_req, res, val: Record<string, unknown>) =>
          enrichLogWithAvailabilitySignal(res, val),
        customErrorObject: (_req, res, _err, val: Record<string, unknown>) =>
          enrichLogWithAvailabilitySignal(res, val),
        // Log redaction denylist (Tier-1/2/5 keys) lives in
        // observability/log-redact.ts so it is importable + unit-tested
        // (test/log-redaction.test.ts). See that file's ADR-0026/0027 sync note.
        redact: {
          paths: [...LOG_REDACT_PATHS],
          censor: LOG_REDACT_CENSOR,
        },
        transport:
          env.NODE_ENV === "production"
            ? undefined
            : {
                target: "pino-pretty",
                options: { singleLine: true },
              },
      },
    }),
    PrismaModule,
    RedisModule,
    QueueModule,
    AuthModule,
    HealthModule,
    VehiclesModule,
    DriversModule,
    TripsModule,
    CustomersModule,
    JobsModule,
    InvoicesModule,
    FuelLogsModule,
    ExpenseLogsModule,
    ReportsModule,
    TelematicsModule,
    RetentionModule,
    GeofencesModule,
    MaintenanceModule,
    NotificationModule,
    NotificationLogsModule,
  ],
})
export class AppModule {}
