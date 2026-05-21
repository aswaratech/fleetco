import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";

import type { AuthInstance } from "./auth";
import { AUTH } from "./auth.tokens";
import type { AuthenticatedRequest } from "./auth.types";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: AuthInstance) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const session = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session) {
      throw new UnauthorizedException();
    }
    request.session = session;
    return true;
  }
}
