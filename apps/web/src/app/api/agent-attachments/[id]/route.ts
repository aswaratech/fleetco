import { cookies } from "next/headers";

// The authed attachment-byte proxy (ADR-0044 V5, DESIGN.md §"Agent chat"
// Attachments): the browser has no direct path to the API in this app
// (apiFetch is server-only), so transcript thumbnails and the full-image
// view stream through this route — one code path across dev and prod, the
// session cookie forwarded, and attachment bytes (Tier-2-handled) never get
// a public URL. The API's owner check is the authorization; this proxy adds
// nothing but transport.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const cookieHeader = (await cookies()).toString();

  const upstream = await fetch(`${baseURL}/api/v1/agent/attachments/${encodeURIComponent(id)}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "private, no-store",
    },
  });
}
