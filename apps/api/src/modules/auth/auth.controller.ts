import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";

import { AuthGuard } from "./auth.guard";
import type { AuthenticatedRequest } from "./auth.types";

// Narrow the better-auth session's `role` to the domain UserRole enum.
// better-auth types the `role` additionalField (declared in auth.ts) as a
// loose, nullable string — it has no native enum field type, so the field is
// `type: "string"` and `required: false`, which surfaces on the session as
// `string | null | undefined`. The underlying `user.role` column is a NOT NULL
// Postgres enum with an OFFICE_STAFF default (ADR-0028 c2/c8), so a valid value
// is ALWAYS present at runtime. This coercion converts the library's loose type
// to the domain type once, at the HTTP boundary, and FAILS CLOSED to the
// least-privileged role if an unexpected or empty value ever appears — a
// corrupted session can never be silently treated as more privileged than
// OFFICE_STAFF.
function toUserRole(role: string | null | undefined): UserRole {
  return role === UserRole.ADMIN || role === UserRole.DRIVER ? role : UserRole.OFFICE_STAFF;
}

@Controller()
export class AuthController {
  @Get("me")
  @UseGuards(AuthGuard)
  me(@Req() req: AuthenticatedRequest): { id: string; email: string; role: UserRole } {
    // role is exposed here (ADR-0028 commitments 3/7) so the web can gate UI
    // for UX — hide ADMIN-only controls (raw-GPS export, observability, user
    // admin) from an OFFICE_STAFF session. This is NOT the security boundary;
    // the authority is always the server-side RolesGuard (T_GUARD) returning
    // 403. A hidden button un-hidden by a tampered client still hits a 403.
    return {
      id: req.session.user.id,
      email: req.session.user.email,
      role: toUserRole(req.session.user.role),
    };
  }
}
