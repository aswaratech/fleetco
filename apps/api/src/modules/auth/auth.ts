import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { bearer } from "better-auth/plugins";
import type { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";

export function createAuth(prisma: PrismaClient) {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    // RBAC role on the better-auth-managed User (ADR-0028 commitments 2/3).
    // Declared as an additionalField so better-auth returns it on
    // session.user.role automatically and the RolesGuard (T_GUARD) reads it
    // with no extra query. The column itself is the Prisma `UserRole` enum
    // (schema.prisma) — better-auth has no native enum field type, so it is
    // declared `type: "string"` here and the allowed values are enforced at
    // the Prisma/Postgres layer by the enum column.
    //   - defaultValue OFFICE_STAFF: new users are least-privileged by
    //     default (ADR-0028 c8); ADMIN is granted only by the explicit
    //     privileged path (T_WIRE's create-user script), never by self-serve.
    //   - input: false: the single most important privilege-escalation
    //     defense (ADR-0028 c8) — `role` can NEVER be set through the public
    //     sign-up / update API, only by a direct server-side Prisma write.
    //   - required: false: the value is always supplied (defaultValue on
    //     create + NOT NULL DB default), so it is never required as input.
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "OFFICE_STAFF",
          input: false,
        },
      },
    },
    // Bearer-token auth for the native driver client (ADR-0034 c1). ADDITIVE:
    // the web's cookie/session flow is unchanged. The plugin returns the signed
    // session token via the `set-auth-token` response header; the Expo client
    // stores it (expo-secure-store) and sends `Authorization: Bearer <token>`.
    // AuthGuard already resolves both cookie and bearer via
    // getSession({ headers: fromNodeHeaders(...) }) — so no guard change. The
    // `fleetco://` app scheme lives on the Expo CLIENT, not here in
    // trustedOrigins (a pure-bearer request is not origin-checked, ADR-0034 c2).
    plugins: [bearer()],
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/auth",
    trustedOrigins: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
