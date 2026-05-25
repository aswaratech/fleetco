import { cookies } from "next/headers";

// Thin server-side fetch helper for the FleetCo API. Forwards the
// inbound Cookie header so the API's AuthGuard (ADR-0021 §6) can
// resolve the session. Returns the parsed JSON body or throws an
// ApiError carrying the response status and parsed server message.
//
// Why a helper rather than inlining fetch in each page or each form:
// one place to wire the API base URL, cookie forwarding, the
// `cache: "no-store"` default that gated pages need, and the JSON
// content-type handling for write methods. The iter-2 ticket extends
// this helper (rather than introducing a parallel write helper) per
// the kickoff rule.
//
// Usage:
//   - Reads (default GET): `apiFetch<T>("/api/v1/vehicles")`
//   - Writes: `apiFetch<T>("/api/v1/vehicles", { method: "POST", json: { ... } })`
//
// The `json` field is a typed sugar on top of RequestInit: when present,
// it is JSON.stringified into the body and `content-type: application/json`
// is set automatically. Callers can still pass `body` directly for the
// rare non-JSON case.
//
// Server-side only: `cookies()` is a server-only Next.js function. Form
// submissions therefore call apiFetch via a server action or via the
// pattern shown in `apps/web/src/app/vehicles/new/page.tsx`, never
// directly from a "use client" component.
export interface ApiFetchInit extends Omit<RequestInit, "body"> {
  json?: unknown;
  body?: BodyInit | null;
}

export async function apiFetch<T>(path: string, init?: ApiFetchInit): Promise<T> {
  const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const headers = new Headers(init?.headers);
  if (cookieHeader) {
    headers.set("cookie", cookieHeader);
  }
  headers.set("accept", "application/json");

  let body: BodyInit | null | undefined = init?.body;
  if (init?.json !== undefined) {
    body = JSON.stringify(init.json);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }

  // Strip `json` before forwarding to fetch — RequestInit does not
  // include it. The destructure also documents which fields we mediate.
  const { json: _json, body: _ignoredBody, ...rest } = init ?? {};
  void _json;
  void _ignoredBody;

  const res = await fetch(`${baseURL}${path}`, {
    ...rest,
    headers,
    body,
    cache: "no-store",
  });

  // 204 No Content (DELETE, future PATCH-without-return-body): return
  // undefined cast to T. Callers expecting void should declare T as void;
  // callers expecting an object should not call DELETE.
  if (res.status === 204) {
    return undefined as T;
  }

  if (!res.ok) {
    // Parse the server's error body for a useful message; fall back to
    // status text. Nest's BadRequestException / ConflictException shape
    // is `{ statusCode, error, message }` with `message` being a string
    // (or an array for class-validator). We surface the string form so
    // the form can render it inline.
    let message = `API ${path} failed: ${res.status} ${res.statusText}`;
    try {
      const errorBody: unknown = await res.json();
      if (errorBody !== null && typeof errorBody === "object" && "message" in errorBody) {
        const m = (errorBody as { message: unknown }).message;
        if (typeof m === "string") {
          message = m;
        } else if (Array.isArray(m)) {
          message = m.filter((entry): entry is string => typeof entry === "string").join("; ");
        }
      }
    } catch {
      // Body was not JSON; keep the default message.
    }
    throw new ApiError(res.status, message);
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
