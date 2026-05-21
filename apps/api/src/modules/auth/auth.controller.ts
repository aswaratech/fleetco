import { Controller, Get, Req, UseGuards } from "@nestjs/common";

import { AuthGuard } from "./auth.guard";
import type { AuthenticatedRequest } from "./auth.types";

@Controller()
export class AuthController {
  @Get("me")
  @UseGuards(AuthGuard)
  me(@Req() req: AuthenticatedRequest): { id: string; email: string } {
    return {
      id: req.session.user.id,
      email: req.session.user.email,
    };
  }
}
