import { cookies } from "next/headers";

// Thin server-side fetch helper for the FleetCo API. Forwards the
// inbound Cookie header so the API's AuthGuard (ADR-0021 §6) can
// resolve the session. Returns the parsed JSON body or throws.
//
// Why a helper rather than inlining fetch in each page: a stable single
// place to wire the API base URL, cookie forwarding, and the
// `cache: "no-store"` default that gated pages need. Future slices add
// a write counterpart (POST/PATCH/DELETE) here.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const headers = new Headers(init?.headers);
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }
  headers.set("accept", "application/json");

  const res = await fetch(`${baseURL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new ApiError(res.status, `API ${path} failed: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
