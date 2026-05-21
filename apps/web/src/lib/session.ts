import { cookies } from "next/headers";

export interface ServerSession {
  user: { id: string; email: string; name: string };
}

// Server-side session fetch. Forwards the inbound Cookie header to the
// API's /auth/get-session endpoint. Used by layout and server components
// to decide whether to render the gated UI or redirect to /login.
//
// We hit the API directly with fetch (instead of better-auth's client)
// because (a) the client expects a browser-like environment with document
// cookies; (b) a single fetch is small enough that the abstraction adds
// little; (c) server components need explicit no-store caching anyway.
export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  if (!cookieHeader) {
    return null;
  }

  const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  try {
    const res = await fetch(`${baseURL}/auth/get-session`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as ServerSession | null;
    if (!data?.user) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
