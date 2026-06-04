import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { type UserRole } from "@prisma/client";

import { AuthGuard } from "./auth.guard";
import type { AuthenticatedRequest } from "./auth.types";
import { toUserRole } from "./permissions";

// `toUserRole` (the fail-closed narrowing of better-auth's loose session role
// to the domain UserRole enum) now lives in permissions.ts so that this
// endpoint and the RolesGuard share ONE coercion and can never disagree on how
// an unexpected value is treated — see the rationale there. It moved on the
// arrival of its second consumer (the guard), the same extraction trigger the
// shared zod-validation.pipe.ts records.
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
