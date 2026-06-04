import { SetMetadata, type CustomDecorator } from "@nestjs/common";
import { type UserRole } from "@prisma/client";

import { type Capability } from "./permissions";

// Route-level RBAC declarations (ADR-0028 commitment 5). A controller declares
// WHAT it requires; the RolesGuard reads these via NestJS's `Reflector` and
// decides. The two keys are stable, namespaced strings so a future reader can
// grep them and so they never collide with another library's metadata.
//
// `@RequirePermission` is PREFERRED — it is capability-based, so adding or
// re-scoping a role touches only the permission map (permissions.ts), not every
// annotated controller. `@RequireRole` is the coarser shortcut, reserved for
// genuinely role-scoped surfaces (observability, user/role admin) where naming
// the role directly is clearer than inventing a one-off capability token.
//
// Opt-in restriction (ADR-0028 c5): a route with NEITHER decorator stays open
// to any AUTHENTICATED caller. These decorators are how a route opts IN to a
// stricter check; their ABSENCE is the (deliberate) default-open posture for
// the trusted ADMIN + OFFICE_STAFF threat model.
export const REQUIRE_PERMISSION_KEY = "fleetco:rbac:require-permission";
export const REQUIRE_ROLE_KEY = "fleetco:rbac:require-role";

// Require that the caller's role holds `capability`. The argument is typed to
// the closed `Capability` union, so `@RequirePermission('gsp:read-raw')` (a
// typo) is a compile error rather than a permanently-denied route.
export const RequirePermission = (capability: Capability): CustomDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, capability);

// Require that the caller's role is exactly `role`. Typed to `UserRole` so only
// a real role can be named.
export const RequireRole = (role: UserRole): CustomDecorator => SetMetadata(REQUIRE_ROLE_KEY, role);
