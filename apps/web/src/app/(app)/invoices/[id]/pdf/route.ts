import { cookies } from "next/headers";
import { type NextRequest } from "next/server";

// Same-origin proxy for the invoice PDF download (D6 / ADR-0039 c6–7). The API's
// `GET /api/v1/invoices/:id/pdf` is AuthGuard-gated and streams a binary
// (application/pdf); a plain browser `<a href>` to the API origin would not carry
// the session cookie cross-origin in development. This Route Handler runs on the
// Next server, forwards the inbound cookie (the apiFetch convention), and streams
// the upstream PDF straight back — so the operator's "Download PDF" link is a
// same-origin `/invoices/<id>/pdf` that works in both dev (web :3000 → api :3001)
// and prod (Caddy routes `/api/*` to the API on the same origin).
//
// The API applies the anti-tamper split itself: an ISSUED invoice streams its
// FROZEN bytes from R2 (never re-rendered); a DRAFT/CANCELLED invoice regenerates
// a watermarked preview. This handler is a transparent pipe — it adds no caching
// and re-surfaces the upstream status (404 for a missing invoice, etc.).

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const baseURL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  const headers = new Headers();
  if (cookieHeader) headers.set("cookie", cookieHeader);
  headers.set("accept", "application/pdf");

  const upstream = await fetch(`${baseURL}/api/v1/invoices/${id}/pdf`, {
    headers,
    cache: "no-store",
  });

  if (!upstream.ok) {
    // Surface the upstream status with a short text body; the link target is a
    // direct navigation, so a plain message is the right shape for the rare error
    // (a deleted invoice, an expired session). The detail page is the recovery
    // path the operator returns to.
    const status = upstream.status;
    const message =
      status === 401
        ? "Your session has expired. Sign in again."
        : status === 404
          ? "Invoice not found."
          : "Could not generate the invoice PDF.";
    return new Response(message, { status, headers: { "content-type": "text/plain" } });
  }

  // Pipe the bytes straight back, preserving the content type + inline filename the
  // API set (the invoice number is the filename). Stream, don't buffer.
  const responseHeaders = new Headers();
  responseHeaders.set("content-type", upstream.headers.get("content-type") ?? "application/pdf");
  const disposition = upstream.headers.get("content-disposition");
  if (disposition) responseHeaders.set("content-disposition", disposition);
  responseHeaders.set("cache-control", "no-store");

  return new Response(upstream.body, { status: 200, headers: responseHeaders });
}
