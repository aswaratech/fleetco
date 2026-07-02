import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type UserRole } from "@prisma/client";

import { REQUIRE_PERMISSION_KEY, REQUIRE_ROLE_KEY } from "./decorators";
import type { AuthenticatedRequest } from "./auth.types";
import { type Capability, roleHasCapability, toUserRole } from "./permissions";

// RolesGuard — the RBAC enforcement point (ADR-0028 commitment 5). It COMPOSES
// the existing AuthGuard rather than replacing it: controllers declare
// `@UseGuards(AuthGuard, RolesGuard)` in THAT order, so AuthGuard runs first,
// resolves the session via better-auth, and attaches it to `request.session`
// (throwing 401 for an anonymous caller). RolesGuard then reads the role off
// that already-attached session — it does NOT re-call getSession, so there is
// no extra query (ADR-0028 c3) and the two guards keep their single
// responsibilities (AuthGuard: "who are you?"; RolesGuard: "may you?").
//
// This realizes ADR-0021's Revisit-when (a): the auth integration shape is
// untouched; only the guard surface grows by composition.
@Injectable()
export class RolesGuard implements CanActivate {
  // `@Inject(Reflector)` is explicit on purpose: Reflector is referenced only
  // as a constructor-parameter type, and with emitDecoratorMetadata a bare type
  // reference would let `consistent-type-imports` rewrite it to `import type`,
  // eliding the runtime import NestJS's DI needs. Naming the token here keeps
  // Reflector a value import and the injection robust regardless of metadata.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  // Synchronous on purpose: unlike AuthGuard, this guard does no I/O. Every
  // input it needs is already present — the requirement in route metadata and
  // the role on the attached session — so it resolves without awaiting.
  canActivate(context: ExecutionContext): boolean {
    // Read both requirement decorators. `getAllAndOverride` walks
    // [handler, class] and lets a method-level decorator override a
    // class-level one, the standard NestJS precedence.
    const requiredRole = this.reflector.getAllAndOverride<UserRole | undefined>(REQUIRE_ROLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPermission = this.reflector.getAllAndOverride<Capability | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Opt-in restriction (ADR-0028 c5): no decorator -> allow. AuthGuard has
    // already rejected anonymous callers with 401, so a route with no RBAC
    // decorator is open to any signed-in user. Since the 2026-07-02 RBAC
    // hardening every domain controller carries @RequirePermission (the
    // opt-in default had left all 12 Phase-1-era controllers open to the live
    // DRIVER role), so this branch now serves only genuinely role-agnostic
    // authenticated routes like GET /me. The session is not even read here.
    if (requiredRole === undefined && requiredPermission === undefined) {
      return true;
    }

    // A restriction IS present. Read the role AuthGuard attached (it rides
    // session.user.role per ADR-0028 c3) and narrow better-auth's loose
    // `string | null | undefined` to the domain enum, failing closed to
    // OFFICE_STAFF on any unexpected value (see toUserRole).
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = toUserRole(request.session.user.role);

    // Deny -> 403 Forbidden, DELIBERATELY distinct from AuthGuard's 401
    // (ADR-0028 c5): 401 = "I don't know who you are"; 403 = "I know who you
    // are and you may not." The implementing tests pin this distinction.
    if (requiredRole !== undefined && role !== requiredRole) {
      throw new ForbiddenException();
    }
    if (requiredPermission !== undefined && !roleHasCapability(role, requiredPermission)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
