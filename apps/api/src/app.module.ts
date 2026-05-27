import { randomUUID } from "node:crypto";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";

import { env } from "./config/env";
import { AuthModule } from "./modules/auth/auth.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { DriversModule } from "./modules/drivers/drivers.module";
import { HealthModule } from "./modules/health/health.module";
import { PrismaModule } from "./modules/prisma/prisma.module";
import { RedisModule } from "./modules/redis/redis.module";
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
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            'res.headers["set-cookie"]',
            "*.password",
            "*.token",
            "*.secret",
            "*.email",
            "*.driverName",
            "*.licenseNumber",
            "*.phoneNumber",
            "*.contactPerson",
          ],
          censor: "[Redacted]",
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
    AuthModule,
    HealthModule,
    VehiclesModule,
    DriversModule,
    TripsModule,
    CustomersModule,
  ],
})
export class AppModule {}
