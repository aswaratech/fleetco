import type { Request } from "express";

import type { AuthInstance } from "./auth";

export type SessionPayload = NonNullable<Awaited<ReturnType<AuthInstance["api"]["getSession"]>>>;

export interface AuthenticatedRequest extends Request {
  session: SessionPayload;
}
