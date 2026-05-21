import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "@prisma/client";

import { env } from "../../config/env";

export function createAuth(prisma: PrismaClient) {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/auth",
    trustedOrigins: env.CORS_ORIGIN.split(",").map((s) => s.trim()),
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
