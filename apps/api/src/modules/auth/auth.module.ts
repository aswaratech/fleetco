import { Module } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";
import { createAuth, type AuthInstance } from "./auth";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AUTH } from "./auth.tokens";
import { DriverScopeService } from "./driver-scope.service";
import { RolesGuard } from "./roles.guard";

// RolesGuard is provided AND exported alongside AuthGuard so domain modules
// consume it exactly as they consume AuthGuard today: import AuthModule, then
// `@UseGuards(AuthGuard, RolesGuard)` on the gated route (ADR-0028 c5). The
// `@RequirePermission`/`@RequireRole` decorators and the ROLE_CAPABILITY_MAP
// are plain ES exports (decorators.ts / permissions.ts) imported directly, the
// same way controllers already import AuthGuard from ./auth.guard — they are
// not NestJS providers, so they are not (and cannot be) listed here.
// RolesGuard's only dependency, the Reflector, is provided globally by
// @nestjs/core, so it needs no entry in `inject`.
@Module({
  controllers: [AuthController],
  providers: [
    AuthGuard,
    RolesGuard,
    // DriverScopeService is the service-layer own-record resolver the Trips and
    // Fuel-logs services inject for DRIVER row-scoping (ADR-0034 c4). Exported so
    // those domain modules consume it the same way they consume AuthGuard —
    // import AuthModule, inject the service. Its only dependency is the @Global
    // PrismaService, so it needs no `inject` wiring here.
    DriverScopeService,
    {
      provide: AUTH,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): AuthInstance => createAuth(prisma),
    },
  ],
  exports: [AUTH, AuthGuard, RolesGuard, DriverScopeService],
})
export class AuthModule {}
