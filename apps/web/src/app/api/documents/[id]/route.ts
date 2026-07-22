import { cookies } from "next/headers";

// The authed fleet-document byte proxy (ADR-0049 F4, DESIGN.md §"Fleet
// documents & renewals"): the browser has no direct path to the API in this
// app (apiFetch is server-only), so the documents table's Open links stream
// through this route — the session cookie forwarded, and document bytes
// (Tier-2-handled) never get a public URL. The API's documents:read gate is
// the authorization; this proxy adds nothing but transport. Byte-for-byte
// the agent-attachments route pattern.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const cookieHeader = (await cookies()).toString();

  const upstream = await fetch(`${baseURL}/api/v1/documents/${encodeURIComponent(id)}/content`, {
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
