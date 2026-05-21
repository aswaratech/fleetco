import { createAuthClient } from "better-auth/react";

// Single client instance shared across server and client components.
// `baseURL` is the API's better-auth mount point (apps/api owns the
// handler at /auth/* per ADR-0021). NEXT_PUBLIC_API_URL must be set in
// apps/web/.env.example or your local apps/web/.env.
const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export const authClient = createAuthClient({
  baseURL: `${baseURL}/auth`,
});

export const { signIn, signOut, useSession } = authClient;
