import { describe, expect, test } from "vitest";

import { TwilioMediaClient, TwilioMediaError } from "../src/modules/whatsapp/twilio-media.client";

// Pure tests for the W5 media download (injected fetch, no network). The
// load-bearing properties: credentials are attached ONLY to https://
// api.twilio.com (the SSRF allowlist), redirects are followed (Twilio 302s to
// pre-signed S3 — undici strips Authorization on the cross-origin hop), the
// size cap fails closed, and errors carry a bare PII-free category.

const SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TOKEN = "test-auth-token";
const MEDIA_URL = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/SM1/Media/ME1`;

function makeClient(
  response: Response,
  opts?: ConstructorParameters<typeof TwilioMediaClient>[0],
): { client: TwilioMediaClient; captured: { input: string; init: RequestInit }[] } {
  const captured: { input: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    captured.push({ input: String(input), init: init ?? {} });
    return Promise.resolve(response);
  };
  const client = new TwilioMediaClient({
    accountSid: SID,
    authToken: TOKEN,
    fetchFn,
    ...opts,
  });
  return { client, captured };
}

describe("TwilioMediaClient.download", () => {
  test("GETs with Basic auth + redirect:follow and returns bytes + the declared type", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const { client, captured } = makeClient(
      new Response(new Uint8Array(jpeg), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    const result = await client.download(MEDIA_URL);

    expect(result.bytes.equals(jpeg)).toBe(true);
    expect(result.declaredContentType).toBe("image/jpeg");
    const request = captured[0];
    if (request === undefined) throw new Error("no request captured");
    expect(request.input).toBe(MEDIA_URL);
    expect((request.init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`,
    );
    // The 302→S3 hop is followed in one call; undici drops Authorization on
    // the cross-origin redirect (the pre-signed URL requires that).
    expect(request.init.redirect).toBe("follow");
  });

  test("throws not_configured before any fetch when credentials are absent", async () => {
    const captured: unknown[] = [];
    const fetchFn: typeof fetch = (input) => {
      captured.push(input);
      return Promise.resolve(new Response("x"));
    };
    const client = new TwilioMediaClient({ accountSid: undefined, authToken: undefined, fetchFn });
    const error = await client.download(MEDIA_URL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwilioMediaError);
    expect((error as TwilioMediaError).category).toBe("not_configured");
    expect(captured).toHaveLength(0);
  });

  test.each([
    ["plain http", `http://api.twilio.com/2010-04-01/Accounts/${SID}/Media/ME1`],
    ["another host", "https://evil.example.com/media/ME1"],
    ["a look-alike suffix host", "https://api.twilio.com.evil.example.com/media/ME1"],
    ["a userinfo trick", "https://api.twilio.com@evil.example.com/media/ME1"],
    ["not a URL at all", "::not a url::"],
  ])("refuses to present credentials to %s (disallowed_url, no fetch)", async (_label, url) => {
    const captured: unknown[] = [];
    const fetchFn: typeof fetch = (input) => {
      captured.push(input);
      return Promise.resolve(new Response("x"));
    };
    const client = new TwilioMediaClient({ accountSid: SID, authToken: TOKEN, fetchFn });
    const error = await client.download(url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwilioMediaError);
    expect((error as TwilioMediaError).category).toBe("disallowed_url");
    expect(captured).toHaveLength(0);
  });

  test("a non-2xx maps to http_<status>", async () => {
    const { client } = makeClient(new Response("gone", { status: 404 }));
    const error = await client.download(MEDIA_URL).catch((e: unknown) => e);
    expect((error as TwilioMediaError).category).toBe("http_404");
  });

  test("a fetch failure maps to network with the cause attached", async () => {
    const boom = new TypeError("fetch failed");
    const client = new TwilioMediaClient({
      accountSid: SID,
      authToken: TOKEN,
      fetchFn: () => Promise.reject(boom),
    });
    const error = await client.download(MEDIA_URL).catch((e: unknown) => e);
    expect((error as TwilioMediaError).category).toBe("network");
    expect((error as TwilioMediaError).cause).toBe(boom);
  });

  test("a hung download aborts at timeoutMs and maps to timeout", async () => {
    const fetchFn: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        });
      });
    const client = new TwilioMediaClient({
      accountSid: SID,
      authToken: TOKEN,
      fetchFn,
      timeoutMs: 5,
    });
    const error = await client.download(MEDIA_URL).catch((e: unknown) => e);
    expect((error as TwilioMediaError).category).toBe("timeout");
  });

  test("a body over the cap fails closed as too_large", async () => {
    const big = Buffer.alloc(64, 0x41);
    const { client } = makeClient(new Response(new Uint8Array(big), { status: 200 }), {
      maxBytes: 32,
    });
    const error = await client.download(MEDIA_URL).catch((e: unknown) => e);
    expect((error as TwilioMediaError).category).toBe("too_large");
  });

  test("error messages never echo the media URL (it embeds account/message SIDs)", async () => {
    const { client } = makeClient(new Response("nope", { status: 401 }));
    const error = await client.download(MEDIA_URL).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(SID);
    expect((error as Error).message).not.toContain("api.twilio.com");
  });
});
